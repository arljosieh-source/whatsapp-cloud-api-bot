import express from "express";
import axios from "axios";
import OpenAI from "openai";
import fs from "fs";

// ===================== CONFIG =====================
const app = express();
app.use(express.json({ limit: "25mb" }));

const PORT = process.env.PORT || 10000;

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Número humano (somente números + DDI). Ex: Brasil: 5573998498514
const HUMAN_WHATSAPP_NUMBER = process.env.HUMAN_WHATSAPP_NUMBER || "393420261950";

// Produto / preço / links
const PRODUCT_NAME = "Mapa Diamond";
const PRICE_FULL = 299;
const PRICE_OFFER = 195;   // 35% OFF
const PRICE_SPECIAL = 125; // só após >=2 objeções reais

const LINK_OFFER = "https://pay.kiwify.com.br/raiY3qd";
const LINK_FULL = "https://pay.kiwify.com.br/UnJnvII";
const LINK_SPECIAL = "https://pay.kiwify.com.br/hfNCals";

// Modo do projeto (o seu é: vender e avisar humano quando lead quente)
const HANDOFF_MODE = "C"; // C = vender + avisar humano quando lead quente (sem “chamei consultor” automático)
const HANDOFF_PAUSE_MS = 0; // se quiser pausar bot depois de lead quente: 5*60*1000

// ===================== VALIDATION =====================
if (!VERIFY_TOKEN || !WHATSAPP_TOKEN || !PHONE_NUMBER_ID || !OPENAI_API_KEY) {
  console.warn(
    "⚠️ Variáveis faltando. Confira: VERIFY_TOKEN, WHATSAPP_TOKEN, PHONE_NUMBER_ID, OPENAI_API_KEY"
  );
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ===================== MEMÓRIA RAM (reinicia no Render) =====================
const sessions = new Map();

function getSession(from) {
  if (!sessions.has(from)) {
    sessions.set(from, {
      history: [],
      stage: 0,               // 0..4
      priceExplained: false,
      expensiveCount: 0,
      linkSentAt: null,
      humanNotified: false,   // avisar humano 1x
      handoffUntil: 0,        // opcional: pause do bot
      lastInboundId: null,    // dedupe
      lastUserTextNorm: null, // anti-repeat
    });
  }
  return sessions.get(from);
}

// ===================== HELPERS =====================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function humanDelay(text) {
  const len = (text || "").length;
  const min = 1500;
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
  return containsAny(t, [
    "quero comprar",
    "quero fechar",
    "comprar",
    "pagar",
    "manda o link",
    "me manda o link",
    "link de pagamento",
    "como pagar",
    "como pago",
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

function truncate(text, max = 650) {
  if (!text) return text;
  return text.length <= max ? text : text.slice(0, max - 3) + "...";
}

function safeWrite(file, line) {
  try { fs.appendFileSync(file, line); } catch {}
}

// ===================== LOG =====================
function log(type, msg, extra = "") {
  const line = `[${new Date().toISOString()}] [${type}] ${msg} ${extra}\n`;
  console.log(line);
  safeWrite("bot.log", line);
}

function registrarLeadQuente({ phone, motivo, mensagem }) {
  const line =
`========================
DATA: ${new Date().toLocaleString()}
NUMERO: ${phone}
MOTIVO: ${motivo}
MENSAGEM: ${mensagem}
========================\n`;
  safeWrite("leads_quentes.txt", line);
}

// ===================== WHATSAPP SEND (TEXT) =====================
async function enviarMensagemText(to, body) {
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

// ===================== WHATSAPP MEDIA (GET + DOWNLOAD) =====================
// Para áudio/imagem/vídeo/documento: WhatsApp manda um media.id
async function getMediaUrl(mediaId) {
  const r = await axios.get(`https://graph.facebook.com/v19.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    timeout: 20000,
  });
  return r.data?.url;
}

async function downloadMediaAsBuffer(mediaUrl) {
  const r = await axios.get(mediaUrl, {
    responseType: "arraybuffer",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    timeout: 30000,
  });
  return Buffer.from(r.data);
}

// ===================== HUMAN NOTIFY =====================
async function avisarHumano(texto) {
  await enviarMensagemText(HUMAN_WHATSAPP_NUMBER, `🔥 LEAD QUENTE 🔥\n\n${texto}`);
}

// ===================== RESPOSTAS PADRÃO (objeções rápidas, sem IA) =====================
const OBJECTIONS = [
  {
    match: (t) => t.includes("funciona"),
    answer:
      "Funciona sim quando você aplica do jeito certo 🙂\nVocê quer mais aprender do zero ou começar a gerar renda o quanto antes?",
  },
  {
    match: (t) => t.includes("quanto tempo") || (t.includes("resultado") && t.includes("tempo")),
    answer:
      "Depende do seu ritmo e da execução 🙂\nVocê pensa em resultado rápido ou em médio prazo?",
  },
  {
    match: (t) => t.includes("ja tentei") || t.includes("já tentei") || t.includes("nao deu certo") || t.includes("não deu certo"),
    answer:
      "Entendo, isso acontece bastante quando falta direção.\nO que mais te travou daquela vez?",
  },
  {
    match: (t) => t.includes("medo") && t.includes("dinheiro"),
    answer:
      "Faz sentido ter esse receio.\nSeu medo é investir errado ou continuar do jeito que está hoje?",
  },
  {
    match: (t) => t.includes("aparecer") || t.includes("gravar video") || t.includes("gravar vídeo"),
    answer:
      "Não é obrigatório 🙂\nVocê prefere algo mais discreto no começo?",
  },
  {
    match: (t) => t.includes("suporte"),
    answer:
      "Tem suporte sim 😊\nPra você, ter acompanhamento faz diferença?",
  },
  {
    match: (t) => t.includes("piramide") || t.includes("pirâmide"),
    answer:
      "Não é pirâmide.\nVocê já teve alguma experiência ruim com algo parecido antes?",
  },
  {
    match: (t) => t.includes("cnpj"),
    answer:
      "Não precisa de CNPJ pra começar.\nVocê quer começar simples ou já pensa em algo mais estruturado?",
  },
  {
    match: (t) => t.includes("parcel") || t.includes("cartao") || t.includes("cartão"),
    answer:
      "Dá pra parcelar sim 🙂\nVocê prefere parcelar ou pagar à vista?",
  },
];

// ===================== SYSTEM PROMPT (produção) =====================
function systemPrompt(stage, expensiveCount) {
  // Seu texto longo do produto vira BASE — mas a IA deve sempre responder curto.
  const productInfoCompact = `
Produto: ${PRODUCT_NAME}.
O Mapa Diamond é um método estratégico de renda digital criado para quem está começando do zero ou já tentou ganhar dinheiro online e não teve resultado.

Ele não promete atalhos irreais nem depende de sorte.
A proposta é simples: mostrar, passo a passo, o que fazer, quando fazer e como aplicar ações práticas que realmente funcionam no digital.

O foco é dar direção clara.
Em vez de testar tudo no escuro, a pessoa segue um processo organizado, com menos tentativa e erro e mais consciência das decisões que está tomando.

É um método pensado para iniciantes:
não exige aparecer,
não exige CNPJ no início
e não depende de vender cursos ou entrar em pirâmides.

A pessoa recebe acesso imediato, aprende o processo de forma progressiva e conta com suporte e acompanhamento durante a aplicação.
Existe também garantia de 7 dias, para que ela possa avaliar com segurança.

O Mapa Diamond não é sobre prometer resultados rápidos.
É sobre consistência com direção, estratégia validada e construção real de renda online.

Sempre conduza a conversa de forma leve, humana e sem pressão.
Use essas informações para esclarecer, não para discursar.
Finalize com uma pergunta estratégica.

`;

  return `
Você é Sarah, consultora premium de orientação digital da Sia Mega.
Você conversa no WhatsApp Brasil como uma HUMANA REAL: natural, educada, segura e estratégica.

REGRAS OBRIGATÓRIAS:
- Nunca diga que é IA/robô/sistema/automação.
- WhatsApp BR: curto, direto e humano.
- 1 frase + 1 pergunta por mensagem (máximo 2 mensagens seguidas).
- Não repetir "oi/tudo bem" se a conversa já começou.
- Pergunte mais do que explica.
- Conduza para o próximo passo, sem pressão.

${productInfoCompact}

ESTÁGIO DO LEAD: STAGE_${stage}
- STAGE_0/1: conexão + diagnóstico
- STAGE_2: valor + clareza (sem preço)
- STAGE_3: decisão
- STAGE_4: objeção de preço (validar, perguntar, construir valor)

GUARDIÃO DO PREÇO (REGRA ABSOLUTA):
- Se perguntarem preço: diga "R$ ${PRICE_FULL}, mas hoje está com 35% OFF por R$ ${PRICE_OFFER}" e PERGUNTE se faz sentido.
- Nunca liste vários preços.
- NÃO mencione R$ ${PRICE_SPECIAL} a menos que expensiveCount >= 2 e você já fez perguntas.
- Links só se o cliente pedir claramente (manda link / quero comprar / como pagar).

Links:
- Oferta (R$ ${PRICE_OFFER}): ${LINK_OFFER}
- Integral (se pedirem especificamente): ${LINK_FULL}
- Especial (último recurso, raro): ${LINK_SPECIAL}

Se o cliente enviar mídia (áudio/imagem/vídeo/documento):
- Seja curta, diga que recebeu e responda com base no conteúdo analisado quando possível.
- Se não der pra analisar, peça uma descrição simples do que ele quer.

Sempre finalize com uma pergunta estratégica.
`;
}

// ===================== OPENAI: AUDIO TRANSCRIBE =====================
async function transcribeAudio(buffer, filename = "audio.ogg") {
  // OpenAI SDK v4: openai.audio.transcriptions.create
  const file = new File([buffer], filename, { type: "audio/ogg" });
  const result = await openai.audio.transcriptions.create({
    file,
    model: "gpt-4o-mini-transcribe",
  });
  return (result.text || "").trim();
}

// ===================== OPENAI: IMAGE UNDERSTAND =====================
async function analyzeImageWithAI(imageBuffer) {
  const base64 = imageBuffer.toString("base64");
  const dataUrl = `data:image/jpeg;base64,${base64}`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "Você é Sarah (Sia Mega). Descreva o que tem na imagem de forma curta e diga como isso se relaciona com a dúvida do cliente. Responda em 1 frase + 1 pergunta.",
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Analise a imagem e me diga o que você percebe, em português BR." },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
  });

  return completion.choices?.[0]?.message?.content?.trim() || "";
}

// ===================== ROUTES =====================
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

app.post("/webhook", async (req, res) => {
  // Responde 200 rápido para a Meta (evita reenvio)
  res.sendStatus(200);

  try {
    const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return;

    const from = msg.from;
    const messageId = msg.id || null;
    const session = getSession(from);

    // Dedupe: evita responder 2x
    if (messageId && session.lastInboundId === messageId) {
      log("DEDUPE", "Ignorado duplicado", `from=${from} id=${messageId}`);
      return;
    }
    session.lastInboundId = messageId;

    // Se estiver em pausa (opcional)
    if (session.handoffUntil && Date.now() < session.handoffUntil) {
      log("HANDOFF", "Em pausa", `from=${from}`);
      return;
    }

    // ===================== DETECT TYPE =====================
    const type = msg.type; // "text", "audio", "image", "video", "document", etc.

    // ---- 1) TEXTO ----
    let rawText = msg.text?.body || "";

    // ---- 2) ÁUDIO -> transcrever ----
    if (type === "audio") {
      const audioId = msg.audio?.id;
      log("IN_MEDIA", "audio", `from=${from} id=${audioId}`);
      try {
        const mediaUrl = await getMediaUrl(audioId);
        const buffer = await downloadMediaAsBuffer(mediaUrl);
        const transcript = await transcribeAudio(buffer, "audio.ogg");
        rawText = transcript || "Enviei um áudio, mas não deu pra entender bem.";
      } catch (e) {
        log("MEDIA_ERR", "Falha transcrição", e?.message || "");
        await humanDelay("Recebi seu áudio 🙂");
        await enviarMensagemText(from, "Recebi seu áudio 🙂\nConsegue me dizer em uma frase o que você quer resolver?");
        return;
      }
    }

    // ---- 3) IMAGEM -> analisar ----
    if (type === "image") {
      const imageId = msg.image?.id;
      log("IN_MEDIA", "image", `from=${from} id=${imageId}`);
      try {
        const mediaUrl = await getMediaUrl(imageId);
        const buffer = await downloadMediaAsBuffer(mediaUrl);
        const analysis = await analyzeImageWithAI(buffer);
        const reply = truncate(analysis || "Recebi a imagem 🙂\nO que você quer que eu avalie nela?", 650);
        await humanDelay(reply);
        await enviarMensagemText(from, reply);

        // histórico
        session.history.push({ role: "user", content: "[imagem enviada]" });
        session.history.push({ role: "assistant", content: reply });
        return;
      } catch (e) {
        log("MEDIA_ERR", "Falha imagem", e?.message || "");
        await humanDelay("Recebi a imagem 🙂");
        await enviarMensagemText(from, "Recebi a imagem 🙂\nO que você quer que eu avalie nela?");
        return;
      }
    }

    // ---- 4) VÍDEO/DOCUMENTO/PDF -> fallback seguro ----
    if (type === "video" || type === "document") {
      log("IN_MEDIA", type, `from=${from}`);
      const reply =
        type === "video"
          ? "Recebi seu vídeo 🙂\nEm uma frase: o que você quer que eu entenda ou te ajude a decidir?"
          : "Recebi seu arquivo 🙂\nVocê quer que eu analise o quê exatamente nele (tema, preço, garantia, ou decisão de compra)?";
      await humanDelay(reply);
      await enviarMensagemText(from, reply);

      session.history.push({ role: "user", content: `[${type} enviado]` });
      session.history.push({ role: "assistant", content: reply });
      return;
    }

    // Se ainda não temos texto, encerra
    if (!rawText || rawText.trim().length < 1) return;

    const raw = rawText.trim();
    const t = normalize(raw);

    // Anti “responder aleatório”: se mensagem repetida idêntica, ignora
    if (session.lastUserTextNorm && session.lastUserTextNorm === t) {
      log("GUARD", "Mensagem repetida ignorada", `from=${from}`);
      return;
    }
    session.lastUserTextNorm = t;

    log("IN", `${from}`, `"${raw}" stage=${session.stage}`);

    // ===================== UPDATE STAGE =====================
    if (session.stage === 0 && session.history.length > 0) session.stage = 1;
    if (isInterested(t)) session.stage = Math.max(session.stage, 2);
    if (isPriceQuestion(t) || isCheckoutIntent(t)) session.stage = 3;

    if (isExpensive(t)) {
      session.expensiveCount += 1;
      session.stage = 4;
    }

    // ===================== NOTIFY HUMAN (1x) =====================
    if (session.stage >= 3 && !session.humanNotified) {
      await avisarHumano(`Número: ${from}\nStage: ${session.stage}\nMsg: "${raw}"`);
      registrarLeadQuente({
        phone: from,
        motivo: `Lead quente (STAGE_${session.stage})`,
        mensagem: raw,
      });
      session.humanNotified = true;

      if (HANDOFF_PAUSE_MS > 0) session.handoffUntil = Date.now() + HANDOFF_PAUSE_MS;
    }

    // ===================== FAST PATHS (controle total) =====================

    // A) Objeções prontas
    for (const item of OBJECTIONS) {
      if (item.match(t)) {
        const reply = item.answer;
        await humanDelay(reply);
        await enviarMensagemText(from, reply);

        session.history.push({ role: "user", content: raw });
        session.history.push({ role: "assistant", content: reply });
        return;
      }
    }

    // B) PREÇO (guardião: nunca listar 3 valores)
    if (isPriceQuestion(t)) {
      session.priceExplained = true;
      const reply = `O valor é R$ ${PRICE_FULL}, mas hoje está com 35% OFF e sai por R$ ${PRICE_OFFER} 🙂\nFaz sentido pro seu objetivo agora?`;
      await humanDelay(reply);
      await enviarMensagemText(from, reply);

      session.history.push({ role: "user", content: raw });
      session.history.push({ role: "assistant", content: reply });
      return;
    }

    // C) COMPRA / PEDIU LINK (isso deve ser prioridade e SEM “já chamei consultor”)
    if (isCheckoutIntent(t)) {
      if (!canSendLink(session)) {
        const reply = "Perfeito.\nVocê prefere pagar à vista ou parcelado?";
        await humanDelay(reply);
        await enviarMensagemText(from, reply);

        session.history.push({ role: "user", content: raw });
        session.history.push({ role: "assistant", content: reply });
        return;
      }

      session.linkSentAt = Date.now();
      const reply = `Perfeito 🙂\nAqui está o link com a oferta de hoje (R$ ${PRICE_OFFER}):\n${LINK_OFFER}\nPrefere pagar à vista ou parcelado?`;
      await humanDelay(reply);
      await enviarMensagemText(from, reply);

      session.history.push({ role: "user", content: raw });
      session.history.push({ role: "assistant", content: reply });
      return;
    }

    // ===================== IA (conversa natural) =====================
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt(session.stage, session.expensiveCount) },
        ...session.history.slice(-8),
        { role: "user", content: raw },
      ],
    });

    let reply = completion.choices?.[0]?.message?.content?.trim() || "Entendi 🙂\nQual é seu objetivo principal hoje?";
    reply = truncate(reply, 700);

    // Guard: não mandar links se cliente não pediu
    if (!isCheckoutIntent(t)) reply = stripUrls(reply);

    // Guard: preço só aparece se perguntou preço
    if (!session.priceExplained && !isPriceQuestion(t)) {
      reply = reply.replace(/R\$\s?\d+(\.\d+)?/g, "").trim();
    }

    // Guard: especial só após >=2 objeções
    if (session.expensiveCount < 2) {
      reply = reply.replace(/\b125\b/g, `${PRICE_OFFER}`);
    }

    // Guard: limite final
    reply = truncate(reply, 650);

    session.history.push({ role: "user", content: raw });
    session.history.push({ role: "assistant", content: reply });

    log("OUT", `${from}`, `"${reply}" stage=${session.stage}`);

    await humanDelay(reply);
    await enviarMensagemText(from, reply);
  } catch (e) {
    log(
      "ERROR",
      "Webhook falhou",
      e?.response?.data ? JSON.stringify(e.response.data) : (e?.message || String(e))
    );
  }
});

app.listen(PORT, () => log("START", `Rodando na porta ${PORT}`));
