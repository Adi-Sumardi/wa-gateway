// Ported verbatim from backend/src/socket.ts's callAiChatbot (post-bugfix):
// distinguishes a genuine answer from a technical failure or the model
// signaling it lacks context, instead of ever sending an error string to the
// customer as if it were a real reply.
const NO_REPLY_SENTINEL = 'NO_REPLY';
const NEED_HUMAN_SENTINEL = 'NEED_HUMAN';

const ABSTAIN_INSTRUCTION = `Anda adalah asisten balas otomatis WhatsApp untuk sebuah bisnis. Balas SEMUA pesan dari calon pelanggan secara normal dan ramah - termasuk sapaan singkat seperti "halo", "hi", "assalamualaikum", "min", "p", dll. Sapaan singkat seperti itu adalah hal wajar dari manusia dan HARUS tetap dibalas seperti biasa (misalnya dengan salam balik dan menawarkan bantuan).

HANYA diam (jangan membalas kalimat apapun, balas HANYA dengan teks persis "${NO_REPLY_SENTINEL}") apabila pesan yang masuk SANGAT JELAS merupakan pesan otomatis dari sistem lain, dicirikan dengan kalimat baku seperti "terima kasih telah menghubungi", "pesan ini dikirim secara otomatis", "balasan otomatis", "kami akan segera merespon", "di luar jam operasional", "auto reply", atau notifikasi sistem (bukan kalimat personal). Jika ragu apakah suatu pesan otomatis atau bukan, JANGAN diam - tetap balas seperti biasa.

Apabila pesan adalah pertanyaan sungguhan dari calon pelanggan TETAPI Anda TIDAK memiliki cukup informasi untuk menjawabnya dengan yakin dan akurat (misalnya menanyakan status pesanan/transaksi spesifik, komplain, refund, permintaan bicara dengan manusia/CS, atau hal di luar konteks bisnis yang diberikan ke Anda) - JANGAN mengarang jawaban. Balas HANYA dengan teks persis "${NEED_HUMAN_SENTINEL}" agar percakapan diteruskan ke tim manusia.`;

export type AiResult =
  | { status: 'ok'; text: string }
  | { status: 'no_reply' }
  | { status: 'uncertain'; detail: string }
  | { status: 'error'; detail: string };

const AI_REQUEST_TIMEOUT_MS = 20000;

export async function callAiChatbot(prompt: string, context?: string): Promise<AiResult> {
  const openAiKey = process.env.OPENAI_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  const systemContent = context ? `${ABSTAIN_INSTRUCTION}\n\n${context}` : ABSTAIN_INSTRUCTION;

  const interpret = (aiText: string | undefined, providerLabel: string): AiResult => {
    if (!aiText) return { status: 'error', detail: `${providerLabel} returned an empty/unparseable response` };
    const trimmed = aiText.trim();
    if (trimmed.toUpperCase() === NO_REPLY_SENTINEL) return { status: 'no_reply' };
    if (trimmed.toUpperCase() === NEED_HUMAN_SENTINEL) return { status: 'uncertain', detail: 'Model signaled it lacks enough context to answer confidently' };
    return { status: 'ok', text: trimmed };
  };

  if (openAiKey) {
    try {
      console.log('[AI] Querying OpenAI API...');
      const messages = [{ role: 'system', content: systemContent }, { role: 'user', content: prompt }];
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS);
      let response;
      try {
        response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openAiKey}` },
          body: JSON.stringify({ model: 'gpt-4o-mini', messages }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok) {
        const bodyText = await response.text();
        console.error(`[OpenAI] Request failed with status ${response.status}:`, bodyText.substring(0, 500));
        return { status: 'error', detail: `OpenAI HTTP ${response.status}` };
      }
      const resJson = (await response.json()) as any;
      const aiText = resJson.choices?.[0]?.message?.content;
      if (!aiText) console.error('[OpenAI] Response parse error. Full response:', JSON.stringify(resJson));
      return interpret(aiText, 'OpenAI');
    } catch (err: any) {
      console.error('[OpenAI] Request failed:', err);
      return { status: 'error', detail: err?.name === 'AbortError' ? 'OpenAI request timed out' : `OpenAI request failed: ${err?.message}` };
    }
  }

  if (geminiKey) {
    try {
      console.log('[AI] Querying Gemini API...');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS);
      let response;
      try {
        response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], systemInstruction: { parts: [{ text: systemContent }] } }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok) {
        const bodyText = await response.text();
        console.error(`[Gemini] Request failed with status ${response.status}:`, bodyText.substring(0, 500));
        return { status: 'error', detail: `Gemini HTTP ${response.status}` };
      }
      const resJson = (await response.json()) as any;
      const aiText = resJson.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!aiText) console.error('[Gemini] Response parse error. Full response:', JSON.stringify(resJson));
      return interpret(aiText, 'Gemini');
    } catch (err: any) {
      console.error('[Gemini] Request failed:', err);
      return { status: 'error', detail: err?.name === 'AbortError' ? 'Gemini request timed out' : `Gemini request failed: ${err?.message}` };
    }
  }

  console.warn('[AI] Neither OPENAI_API_KEY nor GEMINI_API_KEY is configured.');
  return { status: 'error', detail: 'No AI provider API key configured' };
}

// Matches common ways a customer might ask for the brochure/catalog.
export const BROCHURE_KEYWORDS = /brosur|brochure|katalog|catalog|pamflet|flyer/i;

export function buildAiContext(device: { aiContext?: string | null; aiWebsiteUrl?: string | null; aiPriceList?: string | null }): string | undefined {
  const parts: string[] = [];
  if (device.aiContext) parts.push(device.aiContext);
  if (device.aiWebsiteUrl) parts.push(`Website/link pendaftaran resmi: ${device.aiWebsiteUrl}. Sertakan link ini apabila pengguna menanyakan tentang pendaftaran atau website.`);
  if (device.aiPriceList) parts.push(`Daftar harga/biaya:\n${device.aiPriceList}\nGunakan informasi ini apabila pengguna menanyakan harga atau biaya.`);
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}
