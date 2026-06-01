import { getSettings } from '@/lib/settings';

const CHUNK_MIN_CHARS = 1500;
const CHUNK_MAX_CHARS = 2000;
const OVERLAP_CHARS = 200;
const CONCURRENCY_LIMIT = 3;
const LONG_PAUSE_SEC = 0.8;

export const AI_PROVIDERS: { value: string; label: string }[] = [
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'zhipu', label: '智谱AI (GLM)' },
  { value: 'moonshot', label: 'Moonshot (Kimi)' },
];

export const PROVIDER_MODELS: Record<string, { value: string; label: string }[]> = {
  deepseek: [
    { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro (\u6700\u5f3a)' },
    { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash (\u5feb\u901f)' },
  ],
  openai: [
    { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
    { value: 'gpt-5.4', label: 'GPT-5.4' },
    { value: 'gpt-5.4-nano', label: 'GPT-5.4 Nano' },
    { value: 'gpt-4o-mini', label: 'GPT-4o Mini (\u7ecf\u5178)' },
    { value: 'gpt-4o', label: 'GPT-4o' },
    { value: 'o3-mini', label: 'o3-mini' },
  ],
  zhipu: [
    { value: 'GLM-5.1', label: 'GLM-5.1 (\u6700\u65b0\u65d7\u8230)' },
    { value: 'GLM-5', label: 'GLM-5' },
    { value: 'GLM-5-Turbo', label: 'GLM-5 Turbo (\u5feb\u901f)' },
    { value: 'GLM-4.7', label: 'GLM-4.7' },
    { value: 'GLM-4.7-Flash', label: 'GLM-4.7 Flash (\u514d\u8d39)' },
  ],
  moonshot: [
    { value: 'kimi-k2.6', label: 'Kimi K2.6 (\u6700\u65b0\u65d7\u8230)' },
    { value: 'kimi-k2.5', label: 'Kimi K2.5' },
    { value: 'kimi-latest', label: 'Kimi Latest (\u81ea\u52a8\u4e0a\u4e0b\u6587)' },
    { value: 'moonshot-v1-128k', label: 'Moonshot v1 128K' },
    { value: 'moonshot-v1-32k', label: 'Moonshot v1 32K' },
    { value: 'moonshot-v1-8k', label: 'Moonshot v1 8K (\u7ecf\u6d4e)' },
  ],
};

export const PROVIDER_ENDPOINTS: Record<string, string> = {
  openai: 'https://api.openai.com/v1/chat/completions',
  deepseek: 'https://api.deepseek.com/chat/completions',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
  moonshot: 'https://api.moonshot.cn/v1/chat/completions',
};

export const DEFAULT_MODELS: Record<string, string> = {
  deepseek: 'deepseek-v4-flash',
  openai: 'gpt-4o-mini',
  zhipu: 'GLM-4.7-Flash',
  moonshot: 'moonshot-v1-8k',
};

export interface AIPolishResult {
  success: boolean;
  polished: string;
  error?: string;
}

interface SubtitleLine {
  from: number;
  to: number;
  content: string;
}

interface Chunk {
  lines: SubtitleLine[];
  text: string;
  prevOverlap: string;
}

async function buildSystemPrompt(overrideStyle?: string): Promise<string> {
  const settings = await getSettings();
  const ai = settings.ai;

  const style = overrideStyle || ai.promptStyle || 'smooth';
    if (style === 'custom' && ai.customPrompt) return ai.customPrompt;
    if (!overrideStyle && ai.customPrompt) return ai.customPrompt;

    const basePrompt = '\u4f60\u662f\u4e00\u4f4d\u4e25\u8c28\u7684\u6587\u5b57\u7f16\u8f91\u6821\u5bf9\u4e13\u5bb6\u3002\u4f60\u7684\u4efb\u52a1\u662f\u5c06\u8bed\u97f3\u8bc6\u522b\uff08ASR\uff09\u751f\u6210\u7684\u5b57\u5e55\u6587\u672c\u8fdb\u884c\u6807\u70b9\u8865\u5168\u3001\u9519\u522b\u5b57\u4fee\u6b63\u3001\u6bb5\u843d\u5212\u5206\uff0c\u4ee5\u63d0\u5347\u6613\u8bfb\u6027\u3002';

    const stylePrompts: Record<string, string> = {
    smooth: [
      '1. \u8865\u5168\u6807\u70b9\u7b26\u53f7\uff08\u53e5\u53f7\u3001\u9017\u53f7\u3001\u987f\u53f7\u3001\u95ee\u53f7\u3001\u611f\u53f9\u53f7\u7b49\uff09\uff0c\u4f7f\u8bed\u53e5\u81ea\u7136\u6d41\u7545',
      '2. \u4fee\u6b63\u660e\u663e\u7684\u9519\u522b\u5b57\u3001\u8bed\u6cd5\u9519\u8bef\u3001\u540c\u97f3\u8bcd\u8bef\u7528',
      '3. \u53bb\u9664ASR\u4ea7\u751f\u7684\u4e0d\u81ea\u7136\u91cd\u590d\u548c\u6742\u97f3',
      '4. \u4fdd\u6301\u539f\u610f\u548c\u6240\u6709\u4fe1\u606f\u4e0d\u53d8\uff0c\u4e0d\u6dfb\u52a0\u4efb\u4f55\u989d\u5916\u5185\u5bb9',
      '5. \u4f60\u7684\u8f93\u51fa\u957f\u5ea6\u5fc5\u987b\u4e0e\u8f93\u5165\u6587\u672c\u7684\u957f\u5ea6\u57fa\u672c\u4e00\u81f4',
      '6.\u3010\u91cd\u8981\u3011\u5408\u7406\u5206\u6bb5\uff1a\u6839\u636e\u4e3b\u9898\u53d8\u5316\u3001\u8bf4\u8bdd\u4eba\u8f6c\u6362\u3001\u903b\u8f91\u65ad\u70b9\u8fdb\u884c\u81ea\u7136\u5206\u6bb5\u843d\u3002\u6bcf\u6bb53~6\u4e2a\u53e5\u5b50\u4e3a\u5b9c\uff0c\u9047\u5230\u65b0\u4e3b\u9898\u3001\u65b0\u89c2\u70b9\u3001\u5185\u5bb9\u8f6c\u6362\u65f6\u5fc5\u987b\u53e6\u8d77\u4e00\u6bb5\u3002\u7528\u7a7a\u884c\u5206\u9694\u6bb5\u843d',
    ].join('\n'),
    concise: [
      '1. \u53bb\u9664\u53e3\u5934\u7985\u3001\u91cd\u590d\u53e3\u5934\u8bed\u548c\u8bed\u6c14\u8bcd\uff08\u5982\u201c\u5c31\u662f\u8bf4\u201d\u3001\u201c\u8fd9\u4e2a\u201d\u3001\u201c\u90a3\u4e2a\u201d\u3001\u201c\u5bf9\u5427\u201d\u3001\u201c\u55ef\u201d\u3001\u201c\u554a\u201d\u7b49\uff09',
      '2. \u53bb\u9664\u5197\u4f59\u548c\u91cd\u590d\u7684\u5185\u5bb9\uff0c\u4f46\u4fdd\u7559\u6838\u5fc3\u89c2\u70b9\u548c\u5173\u952e\u4fe1\u606f',
      '3. \u4f7f\u8868\u8fbe\u66f4\u7b80\u6d01\u6709\u529b',
      '4. \u7edd\u5bf9\u4e0d\u80fd\u5220\u9664\u6216\u4fee\u6539\u539f\u6709\u7684\u6838\u5fc3\u77e5\u8bc6\u70b9',
      '5.\u3010\u91cd\u8981\u3011\u5408\u7406\u5206\u6bb5\uff1a\u6839\u636e\u4e3b\u9898\u53d8\u5316\u3001\u903b\u8f91\u65ad\u70b9\u8fdb\u884c\u81ea\u7136\u5206\u6bb5\u843d\u3002\u6bcf\u6bb53~5\u4e2a\u53e5\u5b50\uff0c\u9047\u5230\u65b0\u89c2\u70b9\u6216\u5185\u5bb9\u8f6c\u6362\u65f6\u5fc5\u987b\u53e6\u8d77\u4e00\u6bb5\u3002\u7528\u7a7a\u884c\u5206\u9694\u6bb5\u843d',
      '6. \u4fdd\u7559 Markdown \u683c\u5f0f',
    ].join('\n'),
    academic: [
      '1. \u4f7f\u7528\u6b63\u5f0f\u3001\u4e25\u8c28\u7684\u5b66\u672f\u8bed\u8a00\u98ce\u683c',
      '2. \u4f18\u5316\u6bb5\u843d\u7ed3\u6784\u548c\u903b\u8f91\u987a\u5e8f',
      '3. \u8865\u5145\u5fc5\u8981\u7684\u8fc7\u6e21\u884c\u63a5\u8bcd\uff0c\u4f7f\u6bb5\u843d\u4e4b\u95f4\u547c\u5e94\u8fde\u8d2f',
      '4. \u7edd\u5bf9\u4e0d\u80fd\u5220\u9664\u6216\u4fee\u6539\u539f\u6709\u7684\u6838\u5fc3\u77e5\u8bc6\u70b9',
      '5.\u3010\u91cd\u8981\u3011\u5408\u7406\u5206\u6bb5\uff1a\u6309\u7167\u5b66\u672f\u89c4\u8303\u81ea\u7136\u5206\u6bb5\u843d\uff0c\u6bcf\u4e2a\u6bb5\u843d\u8868\u8fbe\u4e00\u4e2a\u5b8c\u6574\u7684\u8bba\u70b9\u6216\u5206\u6790\u5355\u5143\u3002\u8bba\u70b9\u8f6c\u53d8\u3001\u8bba\u8bc1\u89d2\u5ea6\u5207\u6362\u65f6\u53e6\u8d77\u4e00\u6bb5\u3002\u7528\u7a7a\u884c\u5206\u9694\u6bb5\u843d',
      '6. \u4fdd\u7559 Markdown \u683c\u5f0f',
    ].join('\n'),
    summary: [
      '1. \u5bf9\u8f93\u5165\u5185\u5bb9\u8fdb\u884c\u7ed3\u6784\u5316\u6458\u8981',
      '2. \u63d0\u53d6\u6838\u5fc3\u89c2\u70b9\u548c\u5173\u952e\u7ed3\u8bba\uff0c\u6309\u4e3b\u9898\u5206\u7ec4',
      '3. \u4fdd\u7559\u91cd\u8981\u7684\u6570\u636e\u548c\u4e8b\u5b9e',
      '4. \u4f7f\u7528\u5c42\u7ea7\u7ed3\u6784\u7ec4\u7ec7\u5185\u5bb9\uff08\u5927\u6807\u9898 + \u5c0f\u6807\u9898 + \u8981\u70b9\u5217\u8868\uff09',
      '5.\u3010\u91cd\u8981\u3011\u5408\u7406\u5206\u6bb5\uff1a\u6bcf\u4e2a\u5c0f\u6807\u9898\u4e0b\u653e\u4e00\u4e2a\u72ec\u7acb\u6bb5\u843d\uff0c\u76f8\u5173\u8981\u70b9\u7528\u5217\u8868\u5f62\u5f0f\u5448\u73b0\u3002\u4e0d\u540c\u4e3b\u9898\u4e4b\u95f4\u7528\u7a7a\u884c\u660e\u786e\u5206\u9694',
      '6. \u4fdd\u7559 Markdown \u683c\u5f0f',
    ].join('\n'),
  };

  const styleInstruction = stylePrompts[style] || stylePrompts.smooth;

  return `${basePrompt}

\u3010\u7edd\u5bf9\u7981\u6b62\u7684\u7ea2\u7ebf\u6307\u4ee4\u3011\uff1a
- \u7edd\u5bf9\u7981\u6b62\u603b\u7ed3\u3001\u7f29\u5199\u6216\u9057\u6f0f\u4efb\u4f55\u4fe1\u606f
- \u7edd\u5bf9\u4e0d\u80fd\u5220\u9664\u6216\u4fee\u6539\u8bb2\u5e08\u539f\u6709\u7684\u6838\u5fc3\u77e5\u8bc6\u70b9
- \u4f60\u7684\u8f93\u51fa\u957f\u5ea6\u5fc5\u987b\u4e0e\u8f93\u5165\u6587\u672c\u7684\u957f\u5ea6\u57fa\u672c\u4e00\u81f4
- \u4fdd\u7559 Markdown \u683c\u5f0f

\u3010\u5904\u7406\u8981\u6c42\u3011\uff1a
${styleInstruction}

\u3010\u8f93\u5165\u683c\u5f0f\u3011\uff1a
[\u524d\u6587\u53c2\u8003]\uff1a\uff08\u4ec5\u4f9b\u4f60\u7406\u89e3\u4e0a\u4e0b\u6587\u903b\u8f91\uff0c\u4e0d\u8981\u8f93\u51fa\u8fd9\u90e8\u5206\u5185\u5bb9\u7684\u4fee\u6539\uff09
...\uff08\u4e0a\u4e00\u4e2a Chunk \u7684\u6700\u540e\u5185\u5bb9\uff09

[\u9700\u8981\u6da6\u8272\u7684\u6b63\u6587]\uff1a
...\uff08\u5f53\u524d Chunk\uff09

\u8bf7\u76f4\u63a5\u8f93\u51fa\u5904\u7406\u540e\u7684\u3010\u6b63\u6587\u3011\uff0c\u4e0d\u8981\u5305\u542b\u4efb\u4f55\u5176\u4ed6\u7684\u89e3\u91ca\u6027\u5e9f\u8bdd\u3002`;
}

function splitHeaderBody(text: string): { header: string; body: string } {
  const bodyMatch = text.match(/^([\s\S]*?)\n## \u89c6\u9891\u6b63\u6587\n\n([\s\S]+)$/);
  if (bodyMatch) {
    return { header: bodyMatch[1].trim(), body: bodyMatch[2].trim() };
  }
  return { header: '', body: text };
}

function reassembleMarkdown(header: string, polishedBody: string): string {
  if (!header) return polishedBody;
  return `${header}\n\n## \u89c6\u9891\u6b63\u6587\n\n${polishedBody}`;
}

async function polishMergedMarkdown(
  text: string,
  subtitleLines: SubtitleLine[] | undefined,
  systemPrompt: string,
  provider: string,
  apiKey: string,
  model: string,
  onProgress?: (current: number, total: number) => void,
): Promise<{ success: boolean; polished: string; error?: string }> {
  const headerMatch = text.match(/^([\s\S]*?)\n---\n\n([\s\S]+)$/);
  if (!headerMatch) {
    return polishSingleWithChunks(text, subtitleLines, systemPrompt, provider, apiKey, model, onProgress);
  }

  const overallHeader = headerMatch[1].trim();
  const bodyWithChapters = headerMatch[2];

  const chapterBlocks = bodyWithChapters.split(/\n---\n/).map(b => b.trim()).filter(Boolean);

  const chapterParts: { title: string; body: string }[] = [];
  for (const block of chapterBlocks) {
    const titleMatch = block.match(/^(## [^\n]+)\n\n([\s\S]+)$/);
    if (titleMatch) {
      chapterParts.push({ title: titleMatch[1].trim(), body: titleMatch[2].trim() });
    } else {
      chapterParts.push({ title: '', body: block });
    }
  }

  const totalChapters = chapterParts.length;
  const polishedChapters: string[] = [];

  for (let i = 0; i < chapterParts.length; i++) {
    const { title, body } = chapterParts[i];
    onProgress?.(i + 1, totalChapters);

    if (body.length < 100) {
      polishedChapters.push(title ? `${title}\n\n${body}` : body);
      continue;
    }

    try {
      const lines = subtitleLines && subtitleLines.length > 0
        ? subtitleLines
        : body.split('\n').filter(Boolean).map((content, idx) => ({
            from: idx,
            to: idx + 1,
            content,
          }));

      const chunks = chunkSubtitles(lines);

      if (chunks.length <= 1) {
        const result = await polishChunk(
          { lines: [], text: body, prevOverlap: '' },
          0, 1, systemPrompt, provider, apiKey, model,
        );
        polishedChapters.push(title ? `${title}\n\n${result}` : result);
      } else {
        const chunkResults = await polishChunksConcurrently(
          chunks, systemPrompt, provider, apiKey, model,
          (c, t) => onProgress?.(i + c / chunks.length, totalChapters),
        );
        const polishedBody = chunkResults.join('\n\n');
        polishedChapters.push(title ? `${title}\n\n${polishedBody}` : polishedBody);
      }
    } catch (err: any) {
      return { success: false, polished: text, error: err.message || String(err) };
    }
  }

  const finalText = `${overallHeader}\n\n---\n\n${polishedChapters.join('\n\n---\n\n')}`;
  return { success: true, polished: finalText };
}

async function polishSingleWithChunks(
  text: string,
  subtitleLines: SubtitleLine[] | undefined,
  systemPrompt: string,
  provider: string,
  apiKey: string,
  model: string,
  onProgress?: (current: number, total: number) => void,
): Promise<{ success: boolean; polished: string; error?: string }> {
  if (text.length < 300) {
    try {
      const result = await polishChunk(
        { lines: [], text, prevOverlap: '' },
        0, 1, systemPrompt, provider, apiKey, model,
      );
      return { success: true, polished: result };
    } catch (err: any) {
      return { success: false, polished: text, error: err.message || String(err) };
    }
  }

  const lines = subtitleLines && subtitleLines.length > 0
    ? subtitleLines
    : text.split('\n').filter(Boolean).map((content, i) => ({
        from: i,
        to: i + 1,
        content,
      }));

  const chunks = chunkSubtitles(lines);

  if (chunks.length <= 1) {
    try {
      const result = await polishChunk(
        chunks[0], 0, 1, systemPrompt, provider, apiKey, model,
      );
      return { success: true, polished: result };
    } catch (err: any) {
      return { success: false, polished: text, error: err.message || String(err) };
    }
  }

  try {
    const polishedChunks = await polishChunksConcurrently(
      chunks, systemPrompt, provider, apiKey, model, onProgress,
    );
    return { success: true, polished: polishedChunks.join('\n\n') };
  } catch (err: any) {
    return { success: false, polished: text, error: err.message || String(err) };
  }
}

function chunkSubtitles(lines: SubtitleLine[]): Chunk[] {
  const chunks: Chunk[] = [];
  let currentLines: SubtitleLine[] = [];
  let currentText = '';
  let prevOverlap = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const text = line.content?.trim() || '';
    if (!text) continue;

    currentLines.push(line);
    currentText += text;

    const charCount = currentText.length;
    const nextLine = lines[i + 1];

    if (charCount >= CHUNK_MIN_CHARS && nextLine) {
      const timeGap = nextLine.from - line.to;
      if (timeGap > LONG_PAUSE_SEC) {
        chunks.push({ lines: currentLines, text: currentText, prevOverlap });
        prevOverlap = currentText.slice(-OVERLAP_CHARS);
        currentLines = [];
        currentText = '';
        continue;
      }
    }

    if (charCount >= CHUNK_MAX_CHARS && nextLine) {
      chunks.push({ lines: currentLines, text: currentText, prevOverlap });
      prevOverlap = currentText.slice(-OVERLAP_CHARS);
      currentLines = [];
      currentText = '';
    }
  }

  if (currentLines.length > 0) {
    chunks.push({ lines: currentLines, text: currentText, prevOverlap });
  }

  return chunks;
}

async function polishChunk(
  chunk: Chunk,
  chunkIndex: number,
  totalChunks: number,
  systemPrompt: string,
  provider: string,
  apiKey: string,
  model: string,
): Promise<string> {
  const endpoint = PROVIDER_ENDPOINTS[provider];
  if (!endpoint) throw new Error(`Unknown provider: ${provider}`);

  const userContent = chunk.prevOverlap
    ? `\u3010\u524d\u6587\u53c2\u8003\u3011\uff1a
${chunk.prevOverlap}

\u3010\u9700\u8981\u6da6\u8272\u7684\u6b63\u6587\u3011\uff1a
${chunk.text}`
    : `\u3010\u9700\u8981\u6da6\u8272\u7684\u6b63\u6587\u3011\uff1a
${chunk.text}`;

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `\u8fd9\u662f\u7b2c ${chunkIndex + 1}/${totalChunks} \u4e2a\u7247\u6bb5\u3002${userContent}` },
      ],
      temperature: 0.3,
      max_tokens: 8192,
    }),
    signal: AbortSignal.timeout(120000),
  }).catch((err: Error) => {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      throw new Error(`AI \u8bf7\u6c42\u8d85\u65f6\uff0c\u7f51\u7edc\u8f83\u6162\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5`);
    }
    if (err.message?.includes('fetch') || err.message?.includes('network') || err.message?.includes('Failed to fetch')) {
      throw new Error(`\u7f51\u7edc\u8fde\u63a5\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5\u7f51\u7edc\u540e\u91cd\u8bd5`);
    }
    throw err;
  });

  if (!resp.ok) {
    const status = resp.status;
    if (status === 429) {
      throw new Error(`AI \u63a5\u53e3\u7e41\u5fd9\uff08\u9650\u6d41\uff09\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5`);
    }
    if (status === 401 || status === 403) {
      throw new Error(`AI API Key \u65e0\u6548\u6216\u5df2\u8fc7\u671f\uff0c\u8bf7\u68c0\u67e5\u8bbe\u7f6e`);
    }
    if (status === 402) {
      throw new Error(`AI \u8d26\u6237\u4f59\u989d\u4e0d\u8db3\uff0c\u8bf7\u5145\u503c\u540e\u91cd\u8bd5`);
    }
    if (status >= 500) {
      throw new Error(`AI \u670d\u52a1\u5668\u9519\u8bef(${status})\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5`);
    }
    throw new Error(`AI \u8bf7\u6c42\u5931\u8d25(${status})\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5`);
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content || content.trim().length === 0) {
    throw new Error('AI returned empty content');
  }
  return content.trim();
}

async function polishChunksConcurrently(
  chunks: Chunk[],
  systemPrompt: string,
  provider: string,
  apiKey: string,
  model: string,
  onProgress?: (current: number, total: number) => void,
): Promise<string[]> {
  const results: string[] = new Array(chunks.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < chunks.length) {
      const idx = nextIndex++;
      results[idx] = await polishChunk(chunks[idx], idx, chunks.length, systemPrompt, provider, apiKey, model);
      onProgress?.(idx + 1, chunks.length);
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY_LIMIT, chunks.length) }, () => worker());
  await Promise.all(workers);

  return results;
}

export async function polishSubtitlesWithChunks(
  text: string,
  subtitleLines?: SubtitleLine[],
  onProgress?: (current: number, total: number) => void,
  overrideStyle?: string,
): Promise<AIPolishResult> {
  const settings = await getSettings();
  const ai = settings.ai;

  if (!ai?.apiKey || !ai?.provider) {
    return { success: false, polished: text, error: 'AI \u603b\u7ed3\u672a\u914d\u7f6e\uff0c\u8bf7\u5728\u8bbe\u7f6e\u4e2d\u914d\u7f6e API Key' };
  }

  const provider = ai.provider;
  const endpoint = PROVIDER_ENDPOINTS[provider];
  if (!endpoint) {
    return { success: false, polished: text, error: `\u4e0d\u652f\u6301\u7684 AI \u670d\u52a1\u5546: ${provider}` };
  }

  const model = ai.model || DEFAULT_MODELS[provider] || '';
  const systemPrompt = await buildSystemPrompt(overrideStyle);

  const isKaptureMerged = /^# \u5b57\u5e55 \u63d0\u53d6\uff1a/.test(text) && (text.match(/\n---\n/g)?.length || 0) >= 1;

  if (isKaptureMerged) {
    return polishMergedMarkdown(text, subtitleLines, systemPrompt, provider, ai.apiKey, model, onProgress);
  }

  const { header, body } = splitHeaderBody(text);
  const polishTarget = body || text;

  const result = await polishSingleWithChunks(polishTarget, subtitleLines, systemPrompt, provider, ai.apiKey, model, onProgress);
  if (!result.success) return result;
  const final = header ? reassembleMarkdown(header, result.polished) : result.polished;
  return { success: true, polished: final };
}

export async function polishSubtitles(text: string): Promise<AIPolishResult> {
  return polishSubtitlesWithChunks(text);
}

export const PROMPT_STYLES: { value: string; label: string; description: string }[] = [
  { value: 'smooth', label: '\u539f\u5473\u6da6\u8272', description: '\u8865\u5168\u6807\u70b9\u3001\u4fee\u6b63\u9519\u522b\u5b57\uff0c\u4fdd\u6301\u539f\u6c41\u539f\u5473' },
  { value: 'concise', label: '\u7cbe\u7b80\u8868\u8fbe', description: '\u53bb\u6389\u53e3\u7656\u548c\u5197\u4f59\uff0c\u8ba9\u6587\u7ae0\u66f4\u5e72\u51c0' },
  { value: 'academic', label: '\u5b66\u672f\u98ce\u683c', description: '\u6539\u5199\u4e3a\u6b63\u5f0f\u4e25\u8c28\u7684\u5b66\u672f\u8bed\u8a00' },
  { value: 'summary', label: '\u751f\u6210\u6458\u8981', description: '\u63d0\u53d6\u6838\u5fc3\u89c2\u70b9\uff0c\u751f\u6210\u7ed3\u6784\u5316\u6458\u8981' },
];
