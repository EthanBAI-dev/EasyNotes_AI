import { useState, useEffect, useCallback } from 'react';
import {
  MessageCircle,
  Loader2,
  CheckCircle,
  AlertCircle,
  RefreshCw,
  Share2,
  Download,
} from 'lucide-react';
import type { ClaudeConversation, ImportProgress } from '@/lib/types';
import { t } from '@/lib/i18n';
import { PROMPT_STYLES } from '@/services/ai-polish';

interface Props {
  onProgress: (progress: ImportProgress | null) => void;
}

type ImportState = 'idle' | 'extracting' | 'ready' | 'downloading' | 'success' | 'error';
type AIPlatform = 'claude' | 'chatgpt' | 'gemini' | null;

const PLATFORM_CONFIG: Record<string, { name: string; platform: AIPlatform; script: string; icon: string }> = {
  'claude.ai': { name: 'Claude', platform: 'claude', script: 'content-scripts/claude.js', icon: '🟤' },
  'chatgpt.com': { name: 'ChatGPT', platform: 'chatgpt', script: 'content-scripts/chatgpt.js', icon: '🟢' },
  'chat.openai.com': { name: 'ChatGPT', platform: 'chatgpt', script: 'content-scripts/chatgpt.js', icon: '🟢' },
  'gemini.google.com': { name: 'Gemini', platform: 'gemini', script: 'content-scripts/gemini.js', icon: '🔵' },
};

function detectPlatform(url: string) {
  try {
    const hostname = new URL(url).hostname;
    return PLATFORM_CONFIG[hostname] || null;
  } catch {
    return null;
  }
}

function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function AISummary({ onProgress }: Props) {
  const [state, setState] = useState<ImportState>('idle');
  const [error, setError] = useState('');
  const [conversation, setConversation] = useState<ClaudeConversation | null>(null);
  const [selectedPairIds, setSelectedPairIds] = useState<Set<string>>(new Set());
  const [platformInfo, setPlatformInfo] = useState<ReturnType<typeof detectPlatform>>(null);
  const [currentTabId, setCurrentTabId] = useState<number | null>(null);
  const [aiSummary, setAiSummary] = useState(true);
  const [aiPromptStyle, setAiPromptStyle] = useState('summary');

  const [autoExtracted, setAutoExtracted] = useState(false);

  useEffect(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (tab?.url) {
        const info = detectPlatform(tab.url);
        setPlatformInfo(info);
        setCurrentTabId(info ? (tab.id || null) : null);
      }
    });
  }, []);

  const handleExtract = useCallback(async () => {
    if (!currentTabId || !platformInfo) return;

    setState('extracting');
    setError('');

    try {
      await chrome.scripting.executeScript({
        target: { tabId: currentTabId },
        files: [platformInfo.script],
      });
    } catch { /* already injected */ }

    await new Promise((resolve) => setTimeout(resolve, 300));

    chrome.runtime.sendMessage(
      { type: 'EXTRACT_CLAUDE_CONVERSATION', tabId: currentTabId },
      (response) => {
        if (response?.success && response.data) {
          const conv = response.data as ClaudeConversation;
          setConversation(conv);
          const pairs = conv.pairs || [];
          setSelectedPairIds(new Set(pairs.map((p) => p.id)));
          setState('ready');
        } else {
          setState('error');
          setError(response?.error || t('claude.extractFailed'));
        }
      }
    );
  }, [currentTabId, platformInfo]);

  useEffect(() => {
    if (!currentTabId || !platformInfo || autoExtracted || state !== 'idle') return;
    chrome.tabs.get(currentTabId, (tab) => {
      if (chrome.runtime.lastError || !tab?.url) return;
      const url = tab.url;
      const isConversationPage =
        /claude\.ai\/chat\/[a-f0-9-]+/.test(url) ||
        /chatgpt\.com\/c\//.test(url) ||
        /chat\.openai\.com\/c\//.test(url) ||
        /gemini\.google\.com\/app\/[a-f0-9]+/.test(url);
      if (isConversationPage) {
        setAutoExtracted(true);
        handleExtract();
      }
    });
  }, [currentTabId, platformInfo, autoExtracted, state, handleExtract]);

  const handleDownload = async () => {
    if (!conversation) return;
    const pairs = conversation.pairs || [];
    const selected = pairs.filter((p) => selectedPairIds.has(p.id));
    if (selected.length === 0) return;

    setState('downloading');

    const platform = conversation.url.includes('chatgpt.com') || conversation.url.includes('chat.openai.com')
      ? 'ChatGPT' : conversation.url.includes('gemini.google.com') ? 'Gemini' : 'Claude';
    const lines: string[] = [`# ${conversation.title}`, '', `**来源**: ${platform} 对话`, `**URL**: ${conversation.url}`, '', '---', ''];
    for (const pair of selected) {
      if (pair.question) { lines.push('## 👤 Human', '', pair.question, ''); }
      if (pair.answer) { lines.push(`## 🤖 ${platform}`, '', pair.answer, ''); }
      lines.push('---', '');
    }

    let markdown = lines.join('\n');
    
    if (aiSummary) {
      try {
        const { polishSubtitlesWithChunks } = await import('@/services/ai-polish');
        const polished = await polishSubtitlesWithChunks(markdown, undefined, (current, total) => {
          console.log(`AI 总结进度: ${current}/${total}`);
        }, aiPromptStyle);
        
        if (polished.success) {
          markdown = polished.polished;
        } else {
          setState('error');
          setError(polished.error || 'AI 总结失败');
          return;
        }
      } catch (err) {
        setState('error');
        setError(err instanceof Error ? err.message : 'AI 总结处理失败');
        return;
      }
    }

    const filename = `${conversation.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)}.md`;
    const encoded = btoa(unescape(encodeURIComponent(markdown)));
    const dataUrl = `data:text/markdown;base64,${encoded}`;
    await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
    setState('success');
    setTimeout(() => setState('ready'), 3000);
  };

  const togglePair = (id: string) => {
    setSelectedPairIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleShareCard = async () => {
    if (!conversation) return;
    const pairs = conversation.pairs || [];
    const selected = pairs.filter((p) => selectedPairIds.has(p.id));
    if (selected.length === 0) return;

    await chrome.storage.local.set({
      shareCardData: {
        pairs: selected,
        title: conversation.title,
        platform: platformInfo?.name || 'AI',
        platformIcon: platformInfo?.icon || '🤖',
        url: conversation.url,
      },
    });

    chrome.tabs.create({ url: chrome.runtime.getURL('/share-card.html') });
  };

  const pairs = conversation?.pairs || [];
  const allSelected = pairs.length > 0 && selectedPairIds.size === pairs.length;

  if (!platformInfo) {
    return (
      <div className="space-y-4">
        <div className="bg-amber-50/60 border border-amber-200/40 rounded-xl p-4 shadow-soft text-center">
          <MessageCircle className="w-10 h-10 text-amber-500 opacity-80 mx-auto mb-2" />
          <p className="text-sm font-medium text-amber-700">{t('claude.openAiPage')}</p>
          <p className="text-xs text-amber-600/70 mt-1">{t('claude.supported')}</p>
        </div>
        <div className="bg-surface-sunken rounded-xl p-4 space-y-3">
          <p className="text-xs font-medium text-gray-600">{t('claude.guideTitle')}</p>
          <ol className="text-xs text-gray-500 space-y-2 list-none">
            <li className="flex gap-2.5">
              <span className="w-5 h-5 rounded-full bg-brand-600/10 text-brand-600 text-[10px] font-semibold flex items-center justify-center flex-shrink-0">1</span>
              <span>{t('claude.guideStep1')}</span>
            </li>
            <li className="flex gap-2.5">
              <span className="w-5 h-5 rounded-full bg-brand-600/10 text-brand-600 text-[10px] font-semibold flex items-center justify-center flex-shrink-0">2</span>
              <span>{t('claude.guideStep2')}</span>
            </li>
            <li className="flex gap-2.5">
              <span className="w-5 h-5 rounded-full bg-brand-600/10 text-brand-600 text-[10px] font-semibold flex items-center justify-center flex-shrink-0">3</span>
              <span>{t('claude.guideStep3')}</span>
            </li>
            <li className="flex gap-2.5">
              <span className="w-5 h-5 rounded-full bg-brand-600/10 text-brand-600 text-[10px] font-semibold flex items-center justify-center flex-shrink-0">4</span>
              <span>{t('claude.guideStep4')}</span>
            </li>
          </ol>
          <div className="pt-2 border-t border-gray-100">
            <p className="text-[10px] text-gray-400">{t('claude.guideTip')}</p>
          </div>
        </div>
      </div>
    );
  }

  if (state === 'idle' || state === 'extracting' || (state === 'error' && !conversation)) {
    return (
      <div className="space-y-4">
        <button
          onClick={handleExtract}
          disabled={state === 'extracting'}
          className="w-full py-3 bg-brand-600 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-btn hover:shadow-btn-hover transition-all duration-150 btn-press"
        >
          {state === 'extracting' ? (
            <><Loader2 className="w-4 h-4 animate-spin" />{t('claude.extracting')}</>
          ) : (
            <><MessageCircle className="w-4 h-4" />{t('claude.extractCurrent')}</>
          )}
        </button>

        {state === 'error' && (
          <div className="flex items-center gap-2 text-red-500 text-sm bg-red-50 border border-red-100/60 rounded-lg p-3 shadow-soft">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            {error}
          </div>
        )}

        <div className="text-xs text-gray-400 space-y-1 bg-surface-sunken rounded-xl p-3.5">
          <p>{t('claude.currentPlatform')}{platformInfo.icon} {platformInfo.name}</p>
          <p className="mt-1">{t('claude.instructions')}</p>
          <ol className="list-decimal list-inside space-y-0.5">
            <li>{t('claude.step1', { platform: platformInfo.name })}</li>
            <li>{t('claude.step2')}</li>
            <li>{t('claude.step3')}</li>
            <li>{t('claude.step4')}</li>
          </ol>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="bg-surface-sunken rounded-xl p-3 shadow-soft">
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-medium text-gray-900 truncate flex items-center gap-2">
            <span>{platformInfo.icon}</span>
            {conversation?.title}
          </h3>
          <button
            onClick={handleExtract}
            className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-200 rounded"
            title={t('claude.reExtract')}
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
        <p className="text-xs text-gray-500">
          {t('claude.qaPairs', { total: pairs.length, selected: selectedPairIds.size })}
        </p>
      </div>

      {/* Selection controls */}
      <div className="flex gap-2">
        <button
          onClick={() => setSelectedPairIds(new Set(pairs.map((p) => p.id)))}
          disabled={allSelected}
          className="flex-1 px-3 py-1.5 text-xs border border-border rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors duration-150 btn-press"
        >
          {t('selectAll')}
        </button>
        <button
          onClick={() => setSelectedPairIds(new Set())}
          disabled={selectedPairIds.size === 0}
          className="flex-1 px-3 py-1.5 text-xs border border-border rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors duration-150 btn-press"
        >
          {t('deselectAll')}
        </button>
      </div>

      {/* Q&A pair list */}
      <div className="max-h-[240px] overflow-y-auto border border-border-strong rounded-lg shadow-soft">
        {pairs.map((pair, index) => (
          <label
            key={pair.id}
            className="flex items-start gap-3 p-3 hover:bg-gray-50 cursor-pointer border-b border-gray-100/80 last:border-b-0"
          >
            <input
              type="checkbox"
              checked={selectedPairIds.has(pair.id)}
              onChange={() => togglePair(pair.id)}
              className="mt-1 rounded border-gray-300 text-brand-600 focus:ring-brand-600"
            />
            <div className="flex-1 min-w-0 space-y-1">
                <p className="text-xs text-gray-700 line-clamp-2">
                  <span className="text-xs font-mono tabular-nums text-gray-400 mr-1">#{index + 1}</span>
                  <span className="text-gray-400">Q：</span>
                  {pair.question || t('claude.noQuestion')}
                </p>
                <p className="text-xs text-gray-500 line-clamp-2">
                  <span className="text-gray-400">A：</span>
                  {stripMarkdown(pair.answer).slice(0, 100) || t('claude.noAnswer')}
                  {pair.answer.length > 100 && '...'}
                </p>
            </div>
          </label>
        ))}
      </div>

      {/* Output Mode controls with toggle switch */}
      <div className="space-y-3">
        <label className="block text-sm font-medium text-gray-700 flex items-center gap-1.5">
          <Download className="w-4 h-4 text-brand-600" />
          {t('youtube.outputMode')}
        </label>
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-gray-400">.md</span>
          <div className="flex-1" />
          <span className="text-[11px] text-gray-500">AI Summary</span>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={aiSummary}
              onChange={(e) => setAiSummary(e.target.checked)}
              className="sr-only peer"
            />
            <div className="w-7 h-4 bg-gray-200 peer-focus:outline-none peer-focus:ring-1 peer-focus:ring-brand-600/40 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-brand-600"></div>
          </label>
        </div>

        {aiSummary && (
          <div>
            <p className="text-xs font-medium text-gray-600 mb-1.5">{t('youtube.promptStyle')}</p>
            <div className="flex flex-wrap gap-1.5">
              {PROMPT_STYLES.map((style) => (
                <button
                  key={style.value}
                  onClick={() => setAiPromptStyle(style.value)}
                  className={`px-2.5 py-1 text-[11px] rounded-full border transition-colors duration-150 ${
                    aiPromptStyle === style.value
                      ? 'bg-brand-600 text-white border-brand-600'
                      : 'bg-white text-gray-500 border-gray-200 hover:border-brand-300 hover:text-brand-600'
                  }`}
                  title={style.description}
                >
                  {style.label}
                </button>
              ))}
              <button
                onClick={() => setAiPromptStyle('custom')}
                className={`px-2.5 py-1 text-[11px] rounded-full border transition-colors duration-150 ${
                  aiPromptStyle === 'custom'
                    ? 'bg-brand-600 text-white border-brand-600'
                    : 'bg-white text-gray-500 border-gray-200 hover:border-brand-300 hover:text-brand-600'
                }`}
              >
                Custom
              </button>
            </div>
          </div>
        )}

        <div className="flex gap-2">
          <button
            onClick={handleDownload}
            disabled={state === 'downloading' || selectedPairIds.size === 0}
            className="flex-1 py-2.5 bg-brand-600 text-white text-sm rounded-lg hover:bg-brand-600/90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-btn hover:shadow-btn-hover transition-all duration-150 btn-press"
          >
            {state === 'downloading' ? (
              <><Loader2 className="w-4 h-4 animate-spin" />{t('claude.importingBtn')}</>
            ) : (
              <><Download className="w-4 h-4" />{aiSummary ? '下载 AI 总结' : '下载 Markdown'}（{selectedPairIds.size}）</>
            )}
          </button>
          <button
            onClick={handleShareCard}
            disabled={state === 'downloading' || selectedPairIds.size === 0}
            className="py-2.5 px-4 bg-amber-500 text-white text-sm rounded-lg hover:bg-amber-500/90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5 shadow-btn hover:shadow-btn-hover transition-all duration-150 btn-press"
            title={t('claude.shareCard')}
          >
            <Share2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Status */}
      {state === 'success' && (
        <div className="flex items-center gap-2 text-green-600 text-sm bg-green-50 border border-green-100/60 rounded-lg p-3 shadow-soft">
          <CheckCircle className="w-4 h-4" />
          {t('downloadSuccess')}
        </div>
      )}
      {state === 'error' && (
        <div className="flex items-center gap-2 text-red-500 text-sm bg-red-50 border border-red-100/60 rounded-lg p-3 shadow-soft">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

    </div>
  );
}
