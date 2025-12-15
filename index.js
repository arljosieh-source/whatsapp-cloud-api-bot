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
Você é um vendedor profissional da empresa "O Seu Suporte".

Função:
- Atender clientes pelo WhatsApp
- Responder dúvidas
- Explicar o curso
- Informar preços
- Incentivar a compra
- Ser educado e humano
- Nunca dizer que é uma IA
          `
        },
        {
          role: "user",
          content: userMessage
        }
      ]
    });

    const reply = response.output_text || "Desculpe, não consegui responder agora.";

    // ENVIA RESPOSTA PARA O WHATSAPP
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
