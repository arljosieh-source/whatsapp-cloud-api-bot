import express from "express";
import axios from "axios";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import os from "os";

// ===================== CONFIG =====================
const app = express();
app.use(express.json({ limit: "25mb" })); // para aguentar payloads maiores

const PORT = process.env.PORT || 10000;

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Número humano (somente números com DDI; sem +)
// Ex Itália: 393420261950 | Brasil: 5511999999999
const HUMAN_WHATSAPP_NUMBER =
  process.env.HUMAN_WHATSAPP_NUMBER || "393420261950";

// ===================== PRODUTO =====================
const PRODUCT_NAME = "Mapa Diamond";
const PRICE_FULL = 299;
const PRICE_OFFER = 195; // 35% OFF
const PRICE_SPECIAL = 125; // só após >=2 objeções reais

const LINK_OFFER = "https://pay.kiwify.com.br/raiY3qd";
const LINK_FULL = "https://pay.kiwify.com.br/UnJnvII";
const LINK_SPECIAL = "https://pay.kiwify.com.br/hfNCals";

// ===================== OPENAI =====================
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ===================== MEMÓRIA EM RAM =====================
const sessions = new Map();

function getSession(from) {
  if (!sessions.has(from)) {
    sessions.set(from, {
      history: [],
      stage: 0, // 0..4
      priceExplained: false,
      expensiveCount: 0,
      linkSentAt: null,
      humanNotified: false, // avisar humano só 1x
      lastInboundId: null, // dedupe
    });
  }
  return sessions.get(from);
}

// ===================== HELPERS =====================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function humanDelay(text) {
  const len = (text || "").length;
  const min = 1500; // nunca instantâneo
  let ms = 3000;
  if (len > 240) ms = 15000;
  else if (len > 80) ms = 8000;
  await sleep(Math.max(ms, min));
}

function normalize(t) {
  return (t || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim();
}

function containsAny(t, arr) {
  return arr.some((w) => t.includes(w));
}

function isPriceQuestion(t) {
  return containsAny(t, ["preco", "preço", "valor", "quanto", "custa", "investimento"]);
}

function isCheckoutIntent(t) {
  // IMPORTANTE: não trate “link do site / explicar” como compra automática
  // Só compra se ficar claro que é link de pagamento / pagar / comprar
  return containsAny(t, [
    "quero comprar",
    "quero fechar",
    "comprar agora",
    "como pagar",
    "como pago",
    "link de pagamento",
    "manda o link de pagamento",
    "me manda o link de pagamento",
    "pagar",
    "pix",
    "cartao",
    "cartão",
    "boleto",
    "finalizar",
  ]);
}

function isExpensive(t) {
  return containsAny(t, ["caro", "muito caro", "ta caro", "tá caro", "sem dinheiro", "apertado"]);
}

function isInterested(t) {
  return containsAny(t, ["funciona", "como funciona", "suporte", "garantia", "serve pra mim"]);
}

function canSendLink(session) {
  if (!session.linkSentAt) return true;
  return Date.now() - session.linkSentAt > 120000; // 2 min
}

function stripUrls(text) {
  return (text || "").replace(/https?:\/\/\S+/gi, "[link]");
}

function truncate(text, max = 700) {
  if (!text) return text;
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + "...";
}

function safeAppend(file, line) {
  try {
    fs.appendFileSync(file, line);
  } catch {}
}

// ===================== LOG =====================
function log(type, msg, extra = "") {
  const line = `[${new Date().toISOString()}] [${type}] ${msg} ${extra}\n`;
  console.log(line);
  safeAppend("bot.log", line);
}

function registrarLeadQuente({ phone, motivo, mensagem }) {
  const line =
`========================
DATA: ${new Date().toLocaleString()}
NUMERO: ${phone}
MOTIVO: ${motivo}
MENSAGEM: ${mensagem}
========================\n`;
  safeAppend("leads_quentes.txt", line);
}

// ===================== WHATSAPP SEND (texto) =====================
async function enviarMensagem(to, body) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
    { messaging_product: "whatsapp", to, text: { body } },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      timeout: 20000,
    }
  );
}

// ===================== WHATSAPP SEND (mídia) =====================
async function enviarMidia(to, { type, link, caption }) {
  // type: "image" | "video" | "audio" | "document"
  // link: URL pública acessível (https)
  const payload = {
    messaging_product: "whatsapp",
    to,
    type,
    [type]: { link },
  };
  if (caption && (type === "image" || type === "video" || type === "document")) {
    payload[type].caption = caption;
  }

  await axios.post(
    `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
    payload,
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      timeout: 20000,
    }
  );
}

// ===================== AVISO HUMANO (silencioso p/ cliente) =====================
async function avisarHumano(texto) {
  // AVISO INTERNO: não manda nada pro lead dizendo “chamei consultor”
  await enviarMensagem(HUMAN_WHATSAPP_NUMBER, `🔥 LEAD QUENTE 🔥\n\n${texto}`);
}

// ===================== WHATSAPP MEDIA: baixar arquivo =====================
async function getMediaInfo(mediaId) {
  // retorna { url, mime_type, sha256, file_size }
  const r = await axios.get(`https://graph.facebook.com/v19.0/${mediaId}`, {
    params: { fields: "url,mime_type,sha256,file_size" },
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    timeout: 20000,
  });
  return r.data;
}

async function downloadMediaToFile(url, filename) {
  const outPath = path.join(os.tmpdir(), filename);
  const r = await axios.get(url, {
    responseType: "arraybuffer",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    timeout: 30000,
  });
  fs.writeFileSync(outPath, Buffer.from(r.data));
  return outPath;
}

function fileToBase64(filePath) {
  const b = fs.readFileSync(filePath);
  return b.toString("base64");
}

// ===================== TRANSCRIÇÃO (áudio) =====================
async function transcreverAudio(filePath) {
  // Whisper funciona bem e é simples
  const stream = fs.createReadStream(filePath);
  const resp = await openai.audio.transcriptions.create({
    file: stream,
    model: "whisper-1",
  });
  return (resp.text || "").trim();
}

// ===================== RESPOSTAS PADRÃO (rápidas) =====================
const OBJECTIONS = [
  {
    key: "funciona",
    match: (t) => t.includes("funciona"),
    answer: "Funciona sim quando a pessoa aplica do jeito certo 🙂\nVocê quer usar isso mais pra aprender do zero ou pra começar a gerar renda?",
  },
  {
    key: "suporte",
    match: (t) => t.includes("suporte"),
    answer: "Tem suporte sim 😊\nPra você, ter acompanhamento faz diferença?",
  },
  {
    key: "garantia",
    match: (t) => t.includes("garantia"),
    answer: "Tem garantia de 7 dias pra testar com segurança.\nIsso te deixaria mais tranquilo(a) pra decidir?",
  },
  {
    key: "parcelar",
    match: (t) => t.includes("parcel") || t.includes("cartao") || t.includes("cartão"),
    answer: "Dá pra parcelar sim 🙂\nVocê prefere parcelar ou pagar à vista?",
  },
];

// ===================== PROMPT (produção) =====================
function systemPrompt(stage, expensiveCount) {
  return `
Você é Sarah, consultora premium de orientação digital da Sia Mega.
Você conversa no WhatsApp Brasil como uma HUMANA REAL: natural, educada, segura e estratégica.

REGRAS OBRIGATÓRIAS:
- Nunca diga que é IA, robô, sistema ou automação.
- Estilo WhatsApp BR: curto, direto e humano.
- 1 frase + 1 pergunta por mensagem.
- No máximo 2 mensagens seguidas.
- Não repetir "oi/tudo bem" se a conversa já começou.
- Pergunte mais do que explica.
- Sempre conduza para o próximo passo.

PRODUTO:
${PRODUCT_NAME} é um método prático para iniciantes ganharem dinheiro online com estratégia e passo a passo.
Benefícios (cite de forma curta): direção clara, menos tentativa e erro, ações simples, suporte, acesso imediato, garantia 7 dias.

ESTÁGIO DO LEAD: STAGE_${stage}
- STAGE_0/1: conexão + diagnóstico
- STAGE_2: mostrar valor + clareza (sem preço)
- STAGE_3: decisão (mais objetivo)
- STAGE_4: objeção de preço (validar, perguntar, construir valor)

GUARDIÃO DO PREÇO (REGRA ABSOLUTA):
- Se perguntarem preço: diga "R$ ${PRICE_FULL}, mas hoje está com 35% OFF por R$ ${PRICE_OFFER}" e pergunte se faz sentido.
- Não liste vários valores.
- NÃO mencione R$ ${PRICE_SPECIAL} a menos que expensiveCount >= 2 e você já fez perguntas.
- Links de pagamento só se o cliente pedir claramente (link de pagamento / quero comprar / como pagar).
- Se pedirem “link do site/explicação”, NÃO envie link de pagamento automaticamente; ofereça explicar em 1 minuto e pergunte o que ele quer saber.

LINKS (somente quando permitido):
- Oferta: ${LINK_OFFER}
- Integral: ${LINK_FULL}
- Especial (último recurso): ${LINK_SPECIAL}

MÍDIA:
- Se o cliente mandar imagem, descreva o que vê e pergunte o que ele quer fazer com isso.
- Se mandar áudio, responda baseado no conteúdo transcrito e faça uma pergunta.
- Se mandar documento e não der para ler, peça para ele dizer o que precisa ou colar o texto principal.
`;
}

// ===================== ROTAS =====================
app.get("/", (_, res) => res.send("✅ Bot online"));

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    log("WEBHOOK", "Verificado");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ===================== WEBHOOK =====================
app.post("/webhook", async (req, res) => {
  // responde rápido pra Meta
  res.sendStatus(200);

  try {
    const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return;

    const from = msg.from;
    const messageId = msg.id || null;

    const session = getSession(from);

    // dedupe (evita 2 respostas quando a Meta reenvia)
    if (messageId && session.lastInboundId === messageId) {
      log("DEDUPE", `Ignorado duplicado`, `from=${from} id=${messageId}`);
      return;
    }
    session.lastInboundId = messageId;

    // ==========================================
    // 1) Extrair conteúdo (texto OU mídia)
    // ==========================================
    let rawText = "";
    let media = null; // { kind, filePath, mime, caption, transcript, base64, dataUrl }

    if (msg.type === "text") {
      rawText = msg.text?.body || "";
    } else if (msg.type === "audio") {
      // áudio -> baixar -> transcrever
      const mediaId = msg.audio?.id;
      if (!mediaId) return;

      log("IN_MEDIA", `audio from=${from}`, `id=${mediaId}`);

      const info = await getMediaInfo(mediaId);
      const filePath = await downloadMediaToFile(info.url, `audio_${mediaId}.ogg`);

      let transcript = "";
      try {
        transcript = await transcreverAudio(filePath);
      } catch (e) {
        log("AUDIO_ERR", "Falha transcrição", e?.message || "");
      }

      // não trava se falhar
      rawText = transcript
        ? `ÁUDIO TRANSCRITO: ${transcript}`
        : "Recebi seu áudio, mas não consegui transcrever aqui. Pode me mandar em texto o ponto principal?";

      media = { kind: "audio", filePath, mime: info.mime_type, transcript };
    } else if (msg.type === "image") {
      const mediaId = msg.image?.id;
      const caption = msg.image?.caption || "";
      if (!mediaId) return;

      log("IN_MEDIA", `image from=${from}`, `id=${mediaId}`);

      const info = await getMediaInfo(mediaId);
      const ext = (info.mime_type || "image/jpeg").includes("png") ? "png" : "jpg";
      const filePath = await downloadMediaToFile(info.url, `img_${mediaId}.${ext}`);
      const b64 = fileToBase64(filePath);
      const dataUrl = `data:${info.mime_type || "image/jpeg"};base64,${b64}`;

      rawText = caption ? `O cliente enviou uma imagem. Legenda: "${caption}"` : "O cliente enviou uma imagem.";
      media = { kind: "image", filePath, mime: info.mime_type, caption, dataUrl };
    } else if (msg.type === "video") {
      const mediaId = msg.video?.id;
      const caption = msg.video?.caption || "";
      if (!mediaId) return;

      log("IN_MEDIA", `video from=${from}`, `id=${mediaId}`);

      // Vídeo: sem extração automática (pra não quebrar / não travar).
      // A gente responde pedindo o objetivo.
      rawText = caption
        ? `O cliente enviou um VÍDEO com legenda: "${caption}".`
        : "O cliente enviou um VÍDEO.";
      media = { kind: "video", caption };
    } else if (msg.type === "document") {
      const mediaId = msg.document?.id;
      const filename = msg.document?.filename || "arquivo";
      if (!mediaId) return;

      log("IN_MEDIA", `doc from=${from}`, `id=${mediaId} name=${filename}`);

      const info = await getMediaInfo(mediaId);
      const filePath = await downloadMediaToFile(info.url, `doc_${mediaId}_${filename}`);

      // Se for .txt ou texto, tenta ler
      let docText = "";
      if ((info.mime_type || "").startsWith("text/") || filename.toLowerCase().endsWith(".txt")) {
        try {
          docText = fs.readFileSync(filePath, "utf8").slice(0, 5000);
        } catch {}
      }

      rawText = docText
        ? `DOCUMENTO (texto) enviado. Conteúdo:\n${docText}`
        : `Recebi seu documento "${filename}". Me diz o que você quer que eu analise nele?`;
      media = { kind: "document", filePath, mime: info.mime_type, filename, docText };
    } else {
      // outros tipos
      rawText = "Recebi sua mensagem, mas não consegui ler o formato. Você consegue me mandar em texto?";
    }

    if (!rawText || rawText.trim().length < 1) return;

    const t = normalize(rawText);

    log("IN", `${from}`, `"${rawText}" stage=${session.stage}`);

    // ==========================================
    // 2) Atualizar STAGE
    // ==========================================
    if (session.stage === 0 && session.history.length > 0) session.stage = 1;
    if (isInterested(t)) session.stage = Math.max(session.stage, 2);
    if (isPriceQuestion(t) || isCheckoutIntent(t)) session.stage = 3;

    if (isExpensive(t)) {
      session.expensiveCount += 1;
      session.stage = 4;
    }

    // ==========================================
    // 3) Avisar HUMANO (1x) quando lead quente (stage>=3)
    //    IMPORTANTE: NÃO envia “chamei consultor” pro cliente.
    // ==========================================
    if (session.stage >= 3 && !session.humanNotified) {
      await avisarHumano(`Número: ${from}\nStage: ${session.stage}\nMsg: "${rawText}"`);
      registrarLeadQuente({
        phone: from,
        motivo: `Lead quente (STAGE_${session.stage})`,
        mensagem: rawText,
      });
      session.humanNotified = true;
    }

    // ==========================================
    // 4) Fluxos SEM IA (controle duro)
    // ==========================================

    // 4.1) Preço (guardião)
    if (isPriceQuestion(t)) {
      session.priceExplained = true;
      const reply =
        `O valor é R$ ${PRICE_FULL}, mas hoje está com 35% OFF e sai por R$ ${PRICE_OFFER} 🙂\nFaz sentido pro seu objetivo agora?`;
      await humanDelay(reply);
      await enviarMensagem(from, reply);

      session.history.push({ role: "user", content: rawText });
      session.history.push({ role: "assistant", content: reply });
      return;
    }

    // 4.2) Intent compra -> manda link (somente aqui)
    if (isCheckoutIntent(t)) {
      if (!canSendLink(session)) {
        const reply = "Perfeito.\nVocê prefere pagar à vista ou parcelado?";
        await humanDelay(reply);
        await enviarMensagem(from, reply);

        session.history.push({ role: "user", content: rawText });
        session.history.push({ role: "assistant", content: reply });
        return;
      }

      session.linkSentAt = Date.now();
      const reply =
        `Fechado 🙂\nAqui está o link com a oferta de hoje (R$ ${PRICE_OFFER}):\n${LINK_OFFER}\nPrefere pagar à vista ou parcelado?`;
      await humanDelay(reply);
      await enviarMensagem(from, reply);

      session.history.push({ role: "user", content: rawText });
      session.history.push({ role: "assistant", content: reply });
      return;
    }

    // 4.3) Objeções padrão (rápidas)
    for (const item of OBJECTIONS) {
      if (item.match(t)) {
        const reply = item.answer;
        await humanDelay(reply);
        await enviarMensagem(from, reply);

        session.history.push({ role: "user", content: rawText });
        session.history.push({ role: "assistant", content: reply });
        return;
      }
    }

    // ==========================================
    // 5) IA (texto + imagem + áudio transcrito)
    // ==========================================
    let reply = "";

    // Se for imagem: chama modelo com imagem
    if (media?.kind === "image" && media.dataUrl) {
      // Responses API (mais confiável pra multimodal)
      const resp = await openai.responses.create({
        model: "gpt-4o-mini",
        input: [
          { role: "system", content: systemPrompt(session.stage, session.expensiveCount) },
          {
            role: "user",
            content: [
              { type: "input_text", text: rawText },
              { type: "input_image", image_url: media.dataUrl },
            ],
          },
        ],
      });

      reply = (resp.output_text || "").trim();
    } else {
      // Texto normal (inclui áudio transcrito / doc texto)
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt(session.stage, session.expensiveCount) },
          ...session.history.slice(-8),
          { role: "user", content: rawText },
        ],
      });

      reply = completion.choices?.[0]?.message?.content?.trim() || "";
    }

    if (!reply) reply = "Entendi.\nMe diz seu objetivo com isso pra eu te orientar certinho?";

    // ==========================================
    // 6) GUARDIÕES FINAIS
    // ==========================================

    // Limita tamanho
    reply = truncate(reply, 700);

    // Nunca manda link se não for checkout
    // (se IA escapou, troca por [link])
    reply = stripUrls(reply);

    // Se ainda não explicou preço e o cliente NÃO perguntou preço, remove valores
    if (!session.priceExplained && !isPriceQuestion(t)) {
      reply = reply.replace(/R\$\s?\d+(\,\d+)?/g, "").trim();
    }

    // Nunca soltar 125 antes de >=2 objeções
    if (session.expensiveCount < 2) {
      reply = reply.replace(/\b125\b/g, `${PRICE_OFFER}`);
    }

    // Se for vídeo/documento não-lido, não inventar: pede objetivo
    if (media?.kind === "video") {
      reply = "Recebi o vídeo.\nO que você quer que eu analise nele exatamente?";
    }
    if (media?.kind === "document" && !media.docText) {
      reply = `Recebi seu arquivo.\nVocê quer que eu resuma, extraia pontos principais ou procure alguma informação específica?`;
    }

    // ==========================================
    // 7) Salvar histórico e responder
    // ==========================================
    session.history.push({ role: "user", content: rawText });
    session.history.push({ role: "assistant", content: reply });

    log("OUT", `${from}`, `"${reply}" stage=${session.stage}`);

    await humanDelay(reply);
    await enviarMensagem(from, reply);

    // Limpa arquivo temporário (quando existir)
    try {
      if (media?.filePath && fs.existsSync(media.filePath)) fs.unlinkSync(media.filePath);
    } catch {}
  } catch (e) {
    log("ERROR", "Webhook falhou", e?.response?.data ? JSON.stringify(e.response.data) : e?.message);
  }
});

app.listen(PORT, () => log("START", `Rodando na porta ${PORT}`));
