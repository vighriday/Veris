import OpenAI from 'openai';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `You are a helpful customer service agent. Answer concisely.`;

export async function chat(userMessage: string, history: any[] = []) {
  const messages = [
    { role: 'system' as const, content: SYSTEM_PROMPT },
    ...history,
    { role: 'user' as const, content: userMessage }
  ];

  const completion = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages
  });

  return completion.choices[0].message.content;
}

export async function callTool(toolName: string, args: any) {
  const result = await fetch(`https://internal.tools/${toolName}`, {
    method: 'POST',
    body: JSON.stringify(args)
  });
  const json = await result.json();
  return json;
}

export async function embed(text: string) {
  const r = await client.embeddings.create({
    model: 'text-embedding-3-small',
    input: text
  });
  return r.data[0].embedding;
}
