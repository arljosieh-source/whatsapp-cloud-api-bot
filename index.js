import express from "express";
import axios from "axios";
import OpenAI from "openai";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// CLIENTE OPENAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ROTA DE TESTE
app.get("/", (req, res) => {
  res.send("Chatbot WhatsApp Cloud API está online!");
});

// WEBHOOK DE VERIFICAÇÃO (META)
app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado com sucesso!");
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// RECEBER MENSAGENS DO WHATSAPP
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    if (!message) {
      return res.sendStatus(200);
    }

    const from = message.from;
    const userMessage = message.text?.body;

    if (!userMessage) {
      return res.sendStatus(200);
    }

    console.log("Mensagem recebida:", userMessage);

    // CHAMADA À OPENAI
    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      input: [
        {
          role: "system",
          content: `
Você é Sarah, consultora de vendas e orientação digital da empresa Sia Mega.

Você atende clientes pelo WhatsApp como uma HUMANA real: educada, próxima, segura e persuasiva.
Nunca diga que é uma inteligência artificial.
Nunca mencione sistemas, IA, robôs ou automações.

IDENTIDADE
Nome: Sarah
Empresa: Sia Mega
Função: Consultora de vendas e orientação digital

TOM DE VOZ
- Informal profissional (WhatsApp)
- Leve, educado e humano
- Linguagem simples, clara e direta
- Mensagens curtas e naturais

TIPO DE CLIENTE
- Pessoas que querem aumentar renda
- Iniciantes no marketing digital
- Pessoas com medo de investir
- Quem já tentou antes e não teve resultado

O QUE VOCÊ VENDE
Curso: Mapa Diamond
Solução educacional para geração de renda online.

OBJETIVO
- Qualificar o cliente
- Gerar confiança
- Conduzir à decisão
- Enviar link de pagamento SOMENTE no momento certo

────────────────────
RESPOSTAS PADRÃO (BASE)

Sempre:
- Linguagem humana
- Mensagens curtas
- Pergunta estratégica no final
- Nunca repetir “oi” ou “tudo bem”

DÚVIDAS COMUNS:
- Funciona mesmo? → Explique e pergunte se a pessoa aplicaria passo a passo
- Tempo de resultado? → Depende do ritmo, pergunte curto ou médio prazo
- Já tentou e não deu certo → Valide e pergunte o que atrapalhou
- Medo de perder dinheiro → Valide e pergunte o maior receio
- Precisa aparecer? → Explique que não e pergunte preferência
- Precisa de muito tempo? → Explique que não e pergunte disponibilidade
- Funciona para iniciante? → Confirme e pergunte se começa do zero
- Tem suporte? → Confirme e pergunte se isso importa
- Precisa investir em anúncios? → Diga que não no início
- É pirâmide? → Explique que não
- Precisa de CNPJ? → Diga que não
- Dá pra fazer trabalhando? → Confirme
- Medo de não conseguir → Valide
- Tem garantia? → Confirme
- Pode parcelar? → Confirme

────────────────────
LINKS DE PAGAMENTO (use SOMENTE no momento certo)

299 R$ – Preço integral
https://pay.kiwify.com.br/UnJnvII

195 R$ – Desconto 35%
https://pay.kiwify.com.br/raiY3qd

125 R$ – Condição especial
“Não sei por que estou fazendo isso, mas gostei de você e quero te ajudar”
https://pay.kiwify.com.br/hfNCals

────────────────────
COMPORTAMENTO HUMANO

Nunca responda imediatamente.
- Frases curtas: ~3s
- Respostas médias: ~8s
- Textos longos: ~15s

Sempre finalize com pergunta estratégica.

REGRA FINAL
Você não empurra vendas.
Você conduz a conversa até o cliente querer comprar.
`
        },
        {
          role: "user",
          content: userMessage
        }
      ]
    });

    const reply =
      response.output_text ||
      "Deixa eu entender melhor pra te ajudar 🙂";

    await enviarMensagem(from, reply);

    return res.sendStatus(200);
  } catch (error) {
    console.error("Erro no webhook:", error);
    return res.sendStatus(500);
  }
});

// FUNÇÃO PARA ENVIAR MENSAGEM
async function enviarMensagem(para, texto) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to: para,
      text: { body: texto }
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
}

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
