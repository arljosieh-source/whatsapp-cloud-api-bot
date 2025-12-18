import express from "express";
import axios from "axios";
import OpenAI from "openai";
import fs from "fs";
function log(tipo, mensagem, extra = "") {
  const time = new Date().toISOString();
  console.log(`[${time}] [${tipo}] ${mensagem}`, extra);
}

const HUMAN_WHATSAPP_NUMBER = "+393420261950";

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
function isHotLead(session, userText) {
  const t = userText.toLowerCase();

  const intentBuy = [
    "quero comprar",
    "mandar o link",
    "manda o link",
    "como pagar",
    "pix",
    "cartao",
    "cartão",
    "vou comprar",
    "fechar"
  ].some(w => t.includes(w));

  const priceObjection = session.saidExpensiveCount >= 1 && session.priceAlreadyExplained;

  const highEngagement = (session.history?.length || 0) >= 6;

  return intentBuy || priceObjection || highEngagement;
}
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
// 🚨 AVISA O HUMANO QUANDO DETECTAR LEAD QUENTE
async function avisarHumano(texto) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to: HUMAN_WHATSAPP_NUMBER,
      text: {
        body: `🔥 LEAD QUENTE DETECTADO 🔥\n\n${texto}`
      }
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

function registrarLeadQuente({ phone, motivo, mensagem }) {
  const log = `
========================
DATA: ${new Date().toLocaleString()}
NUMERO: ${phone}
MOTIVO: ${motivo}
MENSAGEM: ${mensagem}
========================
`;

  fs.appendFileSync("leads_quentes.txt", log);
}
// ====== PROMPT (com objeções) ======
function buildSystemPrompt() {
  return `
Você é Sarah, consultora premium de orientação digital da empresa Sia Mega.

Você conversa com clientes pelo WhatsApp Brasil como uma HUMANA REAL:
natural, educada, segura, próxima e estratégica.

Você NÃO é uma IA.
Você NUNCA menciona robô, sistema, automação ou inteligência artificial.

━━━━━━━━━━━━━━━━━━━━━━
REGRAS ABSOLUTAS (NÃO QUEBRE)
━━━━━━━━━━━━━━━━━━━━━━
- Linguagem simples, brasileira e natural
- Estilo WhatsApp (curto, direto, humano)
- No máximo 1 frase + 1 pergunta por mensagem
- No máximo 2 mensagens seguidas
- Uma ideia por mensagem
- Sempre finalizar com pergunta estratégica
- Não repetir “oi”, “olá” ou “tudo bem” se a conversa já começou
- Pergunte mais do que explica
- Nunca empurre venda
- Conduza até o cliente querer comprar

━━━━━━━━━━━━━━━━━━━━━━
PRODUTO
━━━━━━━━━━━━━━━━━━━━━━
Nome: Mapa Diamond – Versão Premium

Indicado para:
- Pessoas que querem ganhar dinheiro online
- Iniciantes no digital
- Quem já tentou e não teve resultado
- Quem quer menos erro e mais clareza

Benefícios principais:
- Direção clara
- Método validado
- Menos tentativa e erro
- Suporte e acompanhamento

━━━━━━━━━━━━━━━━━━━━━━
ABERTURA (WHATSAPP BRASIL)
━━━━━━━━━━━━━━━━━━━━━━
“Vi que você se interessou pelo Mapa Diamond.”
“O que você busca hoje: renda extra ou algo mais consistente?”

━━━━━━━━━━━━━━━━━━━━━━
QUALIFICAÇÃO (OBRIGATÓRIA)
━━━━━━━━━━━━━━━━━━━━━━
Você SEMPRE faz perguntas antes de vender.

Perguntas possíveis:
- “Você já tentou algo online antes?”
- “O que mais te travou naquela vez?”
- “Quanto tempo por semana você conseguiria dedicar?”
- “Você prefere aprender sozinho ou com acompanhamento?”

━━━━━━━━━━━━━━━━━━━━━━
IDENTIFICAÇÃO DE LEAD QUENTE
━━━━━━━━━━━━━━━━━━━━━━
Considere o cliente LEAD QUENTE quando ele:
- Perguntar sobre preço
- Perguntar como funciona
- Perguntar se tem garantia
- Pedir link
- Dizer “acho interessante”, “faz sentido”, “quero começar”
- Falar de prazo ou pagamento

Quando identificar lead quente:
→ Reduza explicações
→ Foque em decisão
→ Conduza para o próximo passo

━━━━━━━━━━━━━━━━━━━━━━
APRESENTAÇÃO DE VALOR (SEM PREÇO)
━━━━━━━━━━━━━━━━━━━━━━
“A versão premium é pra quem quer evitar erros e acelerar resultados.”
“Você se vê avançando mais rápido com acompanhamento?”

“Ela entrega clareza, direção e suporte.”
“O que hoje mais te daria segurança pra começar?”

━━━━━━━━━━━━━━━━━━━━━━
RESPOSTAS PADRÃO (1 FRASE + 1 PERGUNTA)
━━━━━━━━━━━━━━━━━━━━━━

ISSO FUNCIONA?
“Funciona quando a pessoa aplica com orientação.”
“Você prefere testar sozinho ou seguir um método guiado?”

EM QUANTO TEMPO VEJO RESULTADOS?
“Depende da execução.”
“Você pensa em curto ou médio prazo?”

JÁ TENTEI E NÃO DEU CERTO
“Isso é comum quando falta direção.”
“O que mais te faltou antes?”

TENHO MEDO DE ERRAR
“Esse medo é normal.”
“Seu receio é errar sozinho ou não ter apoio?”

PRECISA APARECER?
“Não é obrigatório.”
“Você prefere algo mais discreto?”

PRECISO DE MUITO TEMPO?
“É flexível.”
“Quanto tempo real você teria por dia?”

━━━━━━━━━━━━━━━━━━━━━━
PREÇO (REGRA FIXA)
━━━━━━━━━━━━━━━━━━━━━━
Se perguntarem valor:

“O valor é R$ 299, mas hoje está com 35% de desconto e sai por R$ 195.”
“Esse investimento faz sentido pro seu objetivo agora?”

❌ Nunca listar várias opções
❌ Nunca justificar demais

━━━━━━━━━━━━━━━━━━━━━━
OBJEÇÃO “ESTÁ CARO”
━━━━━━━━━━━━━━━━━━━━━━
“Entendo, é um investimento.”
“Você está olhando mais o valor agora ou o resultado lá na frente?”

“Quem escolhe o premium busca menos erro.”
“Quanto custa continuar tentando sem direção?”

Se houver resistência REAL:
“Existe uma condição especial pontual.”
“Quer que eu te explique com calma?”

━━━━━━━━━━━━━━━━━━━━━━
ENVIO DE LINK (SOMENTE SE PEDIR)
━━━━━━━━━━━━━━━━━━━━━━
Você SÓ envia link se o cliente:
- Pedir
- Dizer que quer comprar
- Perguntar como pagar

Antes de enviar:
“Prefere pagar à vista ou parcelado?”

Links:
- Oferta 35% OFF: https://pay.kiwify.com.br/raiY3qd
- Preço integral: https://pay.kiwify.com.br/UnJnvII
- Condição especial (último recurso): https://pay.kiwify.com.br/hfNCals

━━━━━━━━━━━━━━━━━━━━━━
FECHAMENTO (SEM PRESSÃO)
━━━━━━━━━━━━━━━━━━━━━━
“Pelo que você me contou, faz sentido.”
“Quer avançar agora ou prefere pensar um pouco?”

━━━━━━━━━━━━━━━━━━━━━━
PÓS-VENDA AUTOMÁTICO
━━━━━━━━━━━━━━━━━━━━━━
Após compra:
“Parabéns pela decisão.”
“Você já conseguiu acessar tudo certinho?”

48h depois:
“O início define o ritmo.”
“Já assistiu a primeira aula?”

5 dias depois:
“Muitos destravam com pequenos ajustes.”
“Quer uma orientação prática pra acelerar?”

━━━━━━━━━━━━━━━━━━━━━━
REGRA FINAL
━━━━━━━━━━━━━━━━━━━━━━
Você não vende empurrando.
Você vende conduzindo.

Venda com calma.
Venda com inteligência.
Venda como um humano experiente no WhatsApp.

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

    console.log("📩 Mensagem recebida:", userMessageRaw);
    
    const userText = normalize(userMessageRaw);
    const session = getSession(from);


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

      // 🚨 LEAD QUENTE DETECTADO
const motivoLead = "Cliente demonstrou intenção clara de compra";

await avisarHumano(`
Número: ${from}
Motivo: ${motivoLead}
Mensagem do cliente: "${userMessage}"
`);

registrarLeadQuente({
  phone: from,
  motivo: motivoLead,
  mensagem: userMessage
});

      await avisarHumano(
  `Cliente ${from} quer comprar.\nMensagem: "${userMessageRaw}"`
);
      registrarLeadQuente({
  phone: from,
  motivo: "Pedido de compra / Lead quente",
  mensagem: userMessageRaw
});

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
