import express from "express";
import axios from "axios";
import OpenAI from "openai";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ====== CONFIG ======
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Links / Preços (regras do seu negócio)
const PRICE_FULL = "299";
const PRICE_DISCOUNT = "195"; // 35% off
const LINK_FULL = "https://pay.kiwify.com.br/UnJnvII";
const LINK_DISCOUNT = "https://pay.kiwify.com.br/raiY3qd";
const LINK_SPECIAL = "https://pay.kiwify.com.br/hfNCals"; // só em caso excepcional

if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID || !OPENAI_API_KEY || !VERIFY_TOKEN) {
  console.warn(
    "⚠️ Variáveis faltando. Confira: WHATSAPP_TOKEN, PHONE_NUMBER_ID, OPENAI_API_KEY, VERIFY_TOKEN"
  );
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ====== MEMÓRIA (contexto simples por número) ======
const sessions = new Map();
/**
 * sessions.get(from) = {
 *   history: [{role, content}],
 *   lastLinkSentAt: number | null,
 *   priceAlreadyExplained: boolean,
 *   saidExpensiveCount: number
 * }
 */
function getSession(from) {
  if (!sessions.has(from)) {
    sessions.set(from, {
      history: [],
      lastLinkSentAt: null,
      priceAlreadyExplained: false,
      saidExpensiveCount: 0,
    });
  }
  return sessions.get(from);
}

// ====== HELPERS ======
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Simula “tempo humano” antes de responder
async function humanDelay(text) {
  const len = (text || "").length;
  let ms = 3000; // curto
  if (len > 140) ms = 15000; // longo
  else if (len > 60) ms = 8000; // médio
  await sleep(ms);
}

function normalize(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim();
}

function containsAny(text, arr) {
  return arr.some((w) => text.includes(w));
}

// Detecta intenção “pedir preço”
function isPriceQuestion(t) {
  return containsAny(t, [
    "quanto",
    "valor",
    "preco",
    "preço",
    "custa",
    "investimento",
    "qual e o valor",
    "qual o valor",
  ]);
}

// Detecta intenção “quero comprar / manda link / pagamento”
function isCheckoutIntent(t) {
  return containsAny(t, [
    "quero comprar",
    "quero fechar",
    "quero pagar",
    "manda o link",
    "me manda o link",
    "link de pagamento",
    "como pago",
    "como pagar",
    "pix",
    "cartao",
    "cartão",
    "boleto",
    "parcelar",
    "parcelamento",
  ]);
}

// Detecta “caro”
function isExpensiveObjection(t) {
  return containsAny(t, ["caro", "muito caro", "ta caro", "tá caro", "pesado", "salgado"]);
}

// Remove URLs se não estiver autorizado a mandar link
function stripUrls(text) {
  return (text || "").replace(/https?:\/\/\S+/gi, "[link]");
}

// Regras para mandar link (anti-spam simples)
function canSendLink(session) {
  const now = Date.now();
  if (!session.lastLinkSentAt) return true;
  // 2 minutos de intervalo mínimo entre links
  return now - session.lastLinkSentAt > 2 * 60 * 1000;
}

async function enviarMensagem(para, texto) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to: para,
      text: { body: texto },
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

// ====== PROMPT (com objeções) ======
function buildSystemPrompt() {
  return `
Você é Sarah, consultora de vendas e orientação digital da empresa Sia Mega.
Você atende pelo WhatsApp como uma humana real: educada, próxima, segura e persuasiva.
Nunca diga que é uma IA. Nunca mencione sistemas, IA, robôs ou automações.
Mensagem curta e natural (WhatsApp). Uma ideia por mensagem. Sempre finalize com uma pergunta estratégica.
Não repita “oi” ou “tudo bem” se a conversa já começou.

PRODUTO
Curso: Mapa Diamond (para geração de renda online, vendas online e marketing digital para iniciantes).

PREÇO (REGRA FIXA)
Se perguntarem preço/valor/custo:
- Diga: "O valor é R$ ${PRICE_FULL}, mas hoje está com 35% OFF e sai por R$ ${PRICE_DISCOUNT}."
- NÃO liste três valores.
- NÃO fale do valor especial (R$ 125) a menos que a conversa esteja em objeção de preço e após perguntas persuasivas.

LINKS (REGRA FIXA)
Você só pode enviar link quando o cliente pedir claramente (ex.: “manda o link”, “quero comprar”, “como pago”).
- Link principal (oferta 35%): ${LINK_DISCOUNT}
- Link preço integral: ${LINK_FULL}
- Link condição especial (R$ 125): ${LINK_SPECIAL} (use raramente e com elegância)

RESPOSTAS PADRÃO — DÚVIDAS COMUNS (use como base, sem soar robô)
Diretrizes:
- Linguagem humana e natural
- Mensagens curtas
- Tom profissional e próximo
- Sempre com pergunta no final
- Evitar repetir frases desnecessariamente

“ISSO FUNCIONA MESMO?”
→ Diga que funciona se aplicado corretamente e foi pensado para iniciantes. Pergunte se a pessoa se vê aplicando passo a passo.

“EM QUANTO TEMPO VEJO RESULTADOS?”
→ Depende do ritmo; alguns veem nas primeiras semanas, outros levam mais. Pergunte se ela pensa curto ou médio prazo.

“JÁ TENTEI OUTRAS COISAS E NÃO DEU CERTO”
→ Valide e pergunte o que mais atrapalhou antes.

“TENHO MEDO DE PERDER DINHEIRO”
→ Valide e pergunte se o maior medo é investir errado ou continuar como está.

“PRECISA APARECER / GRAVAR VÍDEO?”
→ Não necessariamente; existem formas sem aparecer. Pergunte a preferência.

“PRECISO DE MUITO TEMPO?”
→ Dá pra começar com pouco tempo. Pergunte quanto tempo por dia ela teria.

“FUNCIONA PRA INICIANTE?”
→ Sim; pergunte se está começando do zero.

“TEM SUPORTE?”
→ Sim; pergunte se acompanhamento faz diferença.

“PRECISO INVESTIR EM ANÚNCIOS?”
→ Não no início; pergunte se prefere começar sem gastos extras.

“ISSO É PIRÂMIDE?”
→ Não; é venda e estratégia de produtos/serviços digitais. Pergunte se já teve experiência ruim antes.

“PRECISO TER CNPJ?”
→ Não; pode começar como pessoa física. Pergunte como ela pensa começar.

“POSSO FAZER TRABALHANDO OU ESTUDANDO?”
→ Sim; se adapta à rotina. Pergunte como é a rotina.

“TENHO MEDO DE NÃO CONSEGUIR”
→ Valide; pergunte se o maior medo é errar ou desistir.

“TEM GARANTIA?”
→ Confirme e pergunte se isso ajuda a decidir.

“POSSO PARCELAR?”
→ Confirme e pergunte se prefere parcelar ou à vista.

OBJEÇÃO “ESTÁ CARO”
- Não confronte.
- Não dê desconto imediatamente.
Sequência:
1) Validar
2) Perguntar objetivo e uso (renda vs aprender)
3) Construir valor
4) Se fizer sentido, oferecer a condição de R$ ${PRICE_DISCOUNT}.
Só use o link especial R$ 125 em último caso e com elegância.
`;
}

// ====== ROTAS ======
app.get("/", (req, res) => res.send("✅ Sia Mega WhatsApp Bot online"));

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verificado!");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    if (!message) return res.sendStatus(200);

    const from = message.from;
    const userMessageRaw = message.text?.body;

    if (!userMessageRaw) return res.sendStatus(200);

    const userText = normalize(userMessageRaw);
    const session = getSession(from);

    console.log("📩 Mensagem recebida:", userMessageRaw);

    // 1) Regras rápidas (sem IA) para controlar preço e link
    // A) Pergunta de preço -> resposta padrão (não manda 3 valores)
    if (isPriceQuestion(userText)) {
      session.priceAlreadyExplained = true;
      const reply =
        `O valor é R$ ${PRICE_FULL}, mas hoje está com 35% OFF e sai por R$ ${PRICE_DISCOUNT}. ` +
        `Você quer usar mais pra aprender do zero ou pra começar a gerar renda o quanto antes?`;

      await humanDelay(reply);
      await enviarMensagem(from, reply);
      return res.sendStatus(200);
    }

    // B) Cliente quer comprar/pagar -> manda link (com controle anti-spam)
    if (isCheckoutIntent(userText)) {
      if (!canSendLink(session)) {
        const reply =
          "Perfeito. Só pra eu te orientar direitinho: você prefere pagar à vista ou parcelar?";
        await humanDelay(reply);
        await enviarMensagem(from, reply);
        return res.sendStatus(200);
      }

      session.lastLinkSentAt = Date.now();

      const reply =
        `Fechado 🙂 Aqui está o link com a oferta de hoje (35% OFF):\n${LINK_DISCOUNT}\n\n` +
        `Quer que eu te explique rapidinho o que você recebe dentro do Mapa Diamond antes de finalizar?`;

      await humanDelay(reply);
      await enviarMensagem(from, reply);
      return res.sendStatus(200);
    }

    // C) Objeção “caro” -> aumenta contador (para permitir condição especial só em último caso)
    if (isExpensiveObjection(userText)) {
      session.saidExpensiveCount += 1;
    }

    // 2) IA (resposta conversacional)
    const systemPrompt = buildSystemPrompt();

    // Monta histórico curto (para não ficar caro/lento)
    const history = session.history.slice(-8);

    const messages = [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: userMessageRaw },
    ];

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
    });

    let reply = completion.choices?.[0]?.message?.content?.trim();
    if (!reply) reply = "Entendi. Me conta um pouquinho do seu objetivo pra eu te orientar melhor 🙂";

    // 3) Segurança: se IA tentar mandar link fora da hora, removemos
    const wantsLink = isCheckoutIntent(userText);
    if (!wantsLink) {
      reply = stripUrls(reply);
    }

    // 4) Se IA tentar falar do preço especial cedo demais, força regra
    // (bem simples: se mencionar 125 e ainda não teve objeção “caro” suficiente)
    if (reply.includes("125") && session.saidExpensiveCount < 2) {
      reply = reply.replace(/125/g, PRICE_DISCOUNT);
    }

    // Atualiza histórico
    session.history.push({ role: "user", content: userMessageRaw });
    session.history.push({ role: "assistant", content: reply });

    await humanDelay(reply);
    await enviarMensagem(from, reply);

    return res.sendStatus(200);
  } catch (error) {
    console.error("❌ Erro no webhook:", error?.response?.data || error);
    return res.sendStatus(500);
  }
});

app.listen(PORT, () => console.log(`🚀 Rodando na porta ${PORT}`));
