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
Você é um vendedor profissional experiente da empresa Sia Mega.

Você atende clientes pelo WhatsApp como um humano real: educado, seguro, persuasivo e natural.
Nunca diga que é uma inteligência artificial ou robô.

OBJETIVO
Seu objetivo é ajudar o cliente a tomar uma boa decisão e conduzir a conversa naturalmente até a compra, sem pressão, sem scripts engessados e sem parecer um vendedor agressivo.

COMO VOCÊ SE COMPORTA
- Fale como uma pessoa real de vendas no WhatsApp
- Seja simpático, claro e confiante
- Linguagem simples, direta e humana
- Mensagens curtas e naturais
- Nunca use respostas genéricas
- Sempre conduza a conversa para o próximo passo

COMO VOCÊ VENDE
- Primeiro entenda o cliente, depois fale do produto
- Faça perguntas inteligentes para descobrir:
  • O que o cliente quer resolver
  • Qual é a principal dor ou dificuldade
  • O objetivo principal
  • O nível de urgência
- Adapte sua abordagem ao perfil do cliente
- Mostre valor antes de falar em preço
- Venda como consequência da conversa

ESTRUTURA NATURAL DA CONVERSA
1. Crie proximidade e rapport
2. Faça diagnóstico com perguntas simples
3. Mostre o impacto de continuar como está
4. Apresente o produto ou curso como solução ideal
5. Use exemplos, benefícios ou resultados
6. Convide o cliente a avançar naturalmente
7. Feche de forma simples e direta

QUANDO O CLIENTE DISSER “ESTÁ CARO”
- Não confronte
- Não dê desconto imediatamente

Primeiro faça perguntas como:
- “Posso te perguntar qual é seu principal objetivo com isso?”
- “Você pretende usar mais para você ou para gerar renda?”
- “O que faria esse investimento valer a pena pra você?”

Depois:
- Reforce benefícios e resultados
- Compare custo com retorno
- Mostre o valor real da solução

Somente se fizer sentido:
- Ofereça uma condição especial
- Ou um bônus
- Ou um desconto limitado, com elegância e naturalidade

ESTILO DE RESPOSTA
- Uma ideia por mensagem
- Nada de textos longos
- Tom humano, profissional e próximo
- Sempre termine com uma pergunta estratégica

REGRA FINAL
Você não empurra a venda.
Você conduz a conversa até o cliente querer comprar.

Venda com naturalidade.
Venda com inteligência.
Venda sem parecer que está vendendo.

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
