import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { Headphones, Loader2, CheckCircle, AlertCircle, ChevronDown, ChevronUp, Download, X, Music, Radio, Info, Brain } from 'lucide-react';
import type { PodcastInfo, PodcastEpisode } from '@/services/podcast';
import { t } from '@/lib/i18n';
import { getOpState, clearOpState } from '@/services/op-state';
import { PROMPT_STYLES } from '@/services/ai-polish';
import { getSettings } from '@/lib/settings';
import { MindMap, useMindMapGenerator } from '@/components/MindMap';
import { DownloadOverlay } from '@/components/DownloadOverlay';

type State = 'idle' | 'loading' | 'loaded' | 'downloading' | 'done' | 'error';
type Platform = 'unknown' | 'apple' | 'xiaoyuzhou';

function detectPlatform(url: string): Platform {
  if (/xiaoyuzhoufm\.com\/(episode|podcast)\//.test(url)) return 'xiaoyuzhou';
  if (/podcasts\.apple\.com\//.test(url)) return 'apple';
  return 'unknown';
}

const platformColors = {
  apple: { accent: 'bg-purple-500 hover:bg-purple-600', accentLight: 'bg-purple-50', textAccent: 'text-purple-600', textDark: 'text-purple-900', border: 'border-purple-100/60', ring: 'focus:ring-purple-500', check: 'text-purple-500', dot: 'bg-purple-500' },
  xiaoyuzhou: { accent: 'bg-emerald-500 hover:bg-emerald-600', accentLight: 'bg-emerald-50', textAccent: 'text-emerald-600', textDark: 'text-emerald-900', border: 'border-emerald-100/60', ring: 'focus:ring-emerald-500', check: 'text-emerald-500', dot: 'bg-emerald-500' },
  unknown: { accent: 'bg-purple-500 hover:bg-purple-600', accentLight: 'bg-purple-50', textAccent: 'text-purple-600', textDark: 'text-purple-900', border: 'border-purple-100/60', ring: 'focus:ring-purple-500', check: 'text-purple-500', dot: 'bg-purple-500' },
};
const platformNames: Record<string, string> = {
  apple: 'Apple Podcasts',
  xiaoyuzhou: '小宇宙',
};

interface Props {
  initialUrl?: string;
}

export function PodcastSummary({ initialUrl }: Props) {
  const [url, setUrl] = useState(initialUrl || '');
  const [count, setCount] = useState<number | undefined>(undefined);
  const [state, setState] = useState<State>('idle');
  const [error, setError] = useState('');
  const [podcast, setPodcast] = useState<PodcastInfo | null>(null);
  const [episodes, setEpisodes] = useState<PodcastEpisode[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [doneMsg, setDoneMsg] = useState('');
  const [listExpanded, setListExpanded] = useState(true);

  const [aiPolish, setAiPolish] = useState(true);
  const [aiPromptStyle, setAiPromptStyle] = useState('smooth');
  const [dlProgress, setDlProgress] = useState<{ current: number; total: number; title?: string } | null>(null);
  const abortRef = useRef<{ port?: chrome.runtime.Port; cancel: () => void }>({ cancel: () => {} });

  const { state: mindMapState, mindMapText, error: mindMapError, generate: generateMindMap, setState: setMindMapState } = useMindMapGenerator();
  const [showMindMap, setShowMindMap] = useState(false);

  const isLocked = state === 'downloading';
  const isLockedRef = useRef(false);
  isLockedRef.current = isLocked;

  const platform = useMemo(() => detectPlatform(url), [url]);
  const colors = platformColors[platform];
  const platformName = platformNames[platform] || t('app.tabPodcast');

  useEffect(() => {
    getOpState().then((op) => {
      if (op?.active) {
        setState('downloading');
        setDlProgress({ current: op.current || 0, total: op.total || 0, title: op.title || '' });
      }
    });
  }, []);

  useEffect(() => {
    getSettings().then((s) => {
      if (s.ai.promptStyle) setAiPromptStyle(s.ai.promptStyle);
    });
  }, []);

  const handleFetch = useCallback(() => {
    if (!url) { setError(t('podcast.enterLink')); setState('error'); return; }
    if (platform === 'unknown') { setError(t('podcast.unrecognized')); setState('error'); return; }

    setState('loading');
    setError('');
    setPodcast(null);
    setEpisodes([]);
    setDoneMsg('');

    chrome.runtime.sendMessage(
      { type: 'FETCH_PODCAST', url, count },
      (resp) => {
        if (resp?.success && resp.data) {
          const data = resp.data as { podcast: PodcastInfo; episodes: PodcastEpisode[] };
          setPodcast(data.podcast);
          setEpisodes(data.episodes);
          setSelected(new Set(data.episodes.map((e) => e.id)));
          setState('loaded');
        } else {
          setState('error');
          setError(resp?.error || t('podcast.fetchFailed'));
        }
      },
    );
  }, [url, platform, count, t]);

  const handleCancel = () => {
    abortRef.current.cancel();
    if (abortRef.current.port) {
      try { abortRef.current.port.disconnect(); } catch {}
      abortRef.current.port = undefined;
    }
    clearOpState();
    setDlProgress(null);
    setState('idle');
    setError('操作已取消');
  };

  const handleDownload = () => {
    const toDownload = episodes.filter((e) => selected.has(e.id));
    if (toDownload.length === 0) { setError(t('podcast.selectAtLeastOne')); setState('error'); return; }

    setState('downloading');
    setError('');
    setDoneMsg('');
    setDlProgress({ current: 0, total: toDownload.length });

    const port = chrome.runtime.connect({ name: 'podcast-download' });
    abortRef.current = { port, cancel: () => {} };
    let cancelled = false;

    port.postMessage({
      type: 'DOWNLOAD_PODCAST',
      podcast,
      episodes: toDownload,
      aiPolish,
      promptStyle: aiPromptStyle,
    });

    port.onMessage.addListener((msg) => {
      if (cancelled) return;
      if (msg.phase === 'downloading') {
        setDlProgress({ current: msg.current, total: msg.total, title: msg.title });
      } else if (msg.phase === 'polishing') {
        const cur = Number(msg.current || 0);
        const tot = Number(msg.total || 0);
        const pct = tot > 0 ? Math.round((cur / tot) * 100) : 0;
        setDlProgress({ current: cur, total: tot, title: `AI 润色 ${pct}% (${cur}/${tot})` });
      } else if (msg.phase === 'done') {
        setDlProgress(null);
        port.disconnect();
        abortRef.current = { cancel: () => {} };
        setDoneMsg(`已下载 ${toDownload.length} 个播客音频`);
        setState('done');
      } else if (msg.phase === 'error') {
        setDlProgress(null);
        port.disconnect();
        abortRef.current = { cancel: () => {} };
        setState('error');
        setError(msg.error || t('podcast.downloadFailed'));
      }
    });

    port.onDisconnect.addListener(() => {
      abortRef.current = { cancel: () => {} };
    });

    abortRef.current.cancel = () => { cancelled = true; };
  };

  const toggleEpisode = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(episodes.map((e) => e.id)));
  const selectNone = () => setSelected(new Set());

  const lastAutoUrl = useRef<string | null>(null);
  useEffect(() => {
    if (!initialUrl) return;
    if (isLockedRef.current) return;
    if (lastAutoUrl.current === initialUrl) return;
    lastAutoUrl.current = initialUrl;
    setUrl(initialUrl);
    handleFetch();
  }, [initialUrl]);

  const isWorking = state === 'loading' || state === 'downloading';

  const PlatformIcon = platform === 'xiaoyuzhou' ? Radio : Headphones;

  return (
    <div className="space-y-5">
      {/* Input */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2 flex items-center gap-1.5">
          <PlatformIcon className={`w-4 h-4 ${platform === 'unknown' ? 'text-purple-500' : (platform === 'xiaoyuzhou' ? 'text-emerald-500' : 'text-purple-500')}`} />
          {platform === 'unknown' ? t('podcast.link') : platformName}
        </label>
        <div className="flex gap-2">
          <div className="flex-1 relative">
            <Music className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !isWorking) handleFetch(); }}
              readOnly={isLocked}
              placeholder={t('podcast.placeholder')}
              className="w-full pl-10 pr-3 py-2 border border-gray-200/60 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500/40 focus:border-transparent placeholder:text-gray-400/70"
            />
          </div>
        </div>
        <div className="flex items-center gap-2 mt-2">
          <label className="text-xs text-gray-500">{t('podcast.latest')}</label>
          <input
            type="number"
            value={count || ''}
            onChange={(e) => setCount(e.target.value ? parseInt(e.target.value) : undefined)}
            placeholder={t('podcast.all')}
            min={1}
            max={500}
            className="w-16 px-2 py-1 border border-gray-200/60 rounded text-xs text-center focus:outline-none focus:ring-1 focus:ring-purple-500/40 placeholder:text-gray-400/70"
          />
          <label className="text-xs text-gray-500">{t('podcast.episodes')}</label>
          <div className="flex-1" />
          <button
            onClick={handleFetch}
            disabled={!url || isWorking}
            className={`px-4 py-1.5 ${colors.accent} text-white text-xs rounded-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1 shadow-btn hover:shadow-btn-hover transition-all duration-150 btn-press flex-shrink-0`}
          >
            {state === 'loading' ? (
              <><Loader2 className="w-3 h-3 animate-spin" />{t('podcast.querying')}</>
            ) : (
              <><Music className="w-3 h-3" />{t('podcast.query')}</>
            )}
          </button>
        </div>
      </div>

      {/* Podcast Info */}
      {podcast && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2 flex items-center gap-1.5">
            <Info className={`w-4 h-4 ${colors.textAccent}`} />
            {platformName}
          </label>
          <div className={`border ${colors.border} rounded-lg overflow-hidden shadow-soft`}>
            <div className={`${colors.accentLight} p-3 flex items-center gap-3`}>
              {podcast.artworkUrl && (
                <img src={podcast.artworkUrl} alt="" className="w-10 h-10 rounded-lg object-cover flex-shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <p className={`text-sm font-medium ${colors.textDark} truncate`}>{podcast.name}</p>
                <p className={`text-xs ${colors.textAccent}`}>
                  {podcast.artist}{podcast.artist && ' · '}
                  <span className="font-mono tabular-nums">{episodes.length}</span> {t('podcast.episodes')}
                </p>
              </div>
            </div>

            {episodes.length > 0 && (
              <>
                <div className="flex items-center justify-between px-3 py-1.5 bg-white border-t border-gray-100">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setListExpanded(!listExpanded)}
                      className="text-xs text-gray-400 hover:text-gray-600 transition-colors flex items-center gap-0.5"
                    >
                      {listExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                      {listExpanded ? '收起' : '展开'}
                    </button>
                    <span className="text-xs text-gray-500">
                      {t('podcast.selectedEpisodes', { selected: selected.size, total: episodes.length })}
                    </span>
                  </div>
                  <div className="flex gap-2 text-xs">
                    <button onClick={selectAll} className={`${colors.textAccent} hover:underline`}>{t('selectAll')}</button>
                    <button onClick={selectNone} className="text-gray-400 hover:underline">{t('deselectAll')}</button>
                  </div>
                </div>
                {listExpanded && (
                  <div className="overflow-y-auto bg-white" style={{ maxHeight: 192 }}>
                    {episodes.map((ep) => (
                      <label
                        key={ep.id}
                        className="flex items-start gap-3 p-2 hover:bg-gray-50 cursor-pointer border-b border-gray-100 last:border-b-0 transition-colors duration-150"
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(ep.id)}
                          onChange={() => toggleEpisode(ep.id)}
                          className={`mt-1 rounded border-gray-300 ${colors.check} ${colors.ring}`}
                        />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-gray-700 line-clamp-1">{ep.title}</p>
                          <p className="text-xs text-gray-400 mt-0.5">
                            {ep.releaseDate} {ep.durationMinutes > 0 && `· ${ep.durationMinutes} ${t('podcast.minutes')}`}
                          </p>
                        </div>
                      </label>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Mind Map */}
      {episodes.length > 0 && !showMindMap && (
        <button
          onClick={() => {
            setShowMindMap(true);
            const subtitleText = podcast
              ? `标题：${podcast.name}\n艺术家：${podcast.artist || ''}\n\n` +
                episodes.map(e => `【${e.title}】\n${e.description || ''}`).join('\n\n')
              : '';
            generateMindMap({ subtitleText, sourceTitle: podcast?.name });
          }}
          disabled={mindMapState === 'loading'}
          className="w-full py-2 text-xs text-purple-500 hover:text-purple-600 hover:bg-purple-50 border border-purple-200/60 rounded-lg flex items-center justify-center gap-1.5 transition-colors duration-150 disabled:opacity-50"
        >
          {mindMapState === 'loading' ? (
            <><Loader2 className="w-3 h-3 animate-spin" />{t('mindmap.generating')}</>
          ) : (
            <><Brain className="w-3 h-3" />{t('mindmap.generate')}</>
          )}
        </button>
      )}
      {showMindMap && (mindMapState === 'loading' || mindMapState === 'done') && (
        <MindMap
          text={mindMapText}
          onClose={() => { setShowMindMap(false); setMindMapState('idle'); }}
        />
      )}
      {showMindMap && mindMapState === 'error' && (
        <div className="flex items-center gap-2 text-red-500 text-xs bg-red-50 border border-red-100/60 rounded-lg p-2">
          <AlertCircle className="w-3 h-3 flex-shrink-0" />
          {mindMapError}
        </div>
      )}

      {/* Download Section */}
      {episodes.length > 0 && (
        <div className="space-y-3">
          <label className="block text-sm font-medium text-gray-700 flex items-center gap-1.5">
            <Download className={`w-4 h-4 ${colors.textAccent}`} />
            {t('podcast.aiSummary')}
          </label>
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-gray-400">.mp3</span>
            <div className="flex-1" />
            <span className="text-[11px] text-gray-500">{t('podcast.aiSummary')}</span>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={aiPolish}
                onChange={(e) => setAiPolish(e.target.checked)}
                className="sr-only peer"
              />
              <div className={`w-7 h-4 bg-gray-200 peer-focus:outline-none peer-focus:ring-1 peer-focus:ring-purple-500/40 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:${colors.dot}`}></div>
            </label>
          </div>

          {aiPolish && (
            <div>
              <p className="text-xs font-medium text-gray-600 mb-1.5">{t('podcast.promptStyle')}</p>
              <div className="flex flex-wrap gap-1.5">
                {PROMPT_STYLES.map((style) => (
                  <button
                    key={style.value}
                    onClick={() => setAiPromptStyle(style.value)}
                    className={`px-2.5 py-1 text-[11px] rounded-full border transition-colors duration-150 ${
                      aiPromptStyle === style.value
                        ? `${colors.accent} text-white`
                        : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'
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
                      ? `${colors.accent} text-white`
                      : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'
                  }`}
                >
                  Custom
                </button>
              </div>
            </div>
          )}

          <button
            onClick={handleDownload}
            disabled={selected.size === 0 || isWorking}
            className={`w-full py-2.5 ${colors.accent} text-white text-sm rounded-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-btn hover:shadow-btn-hover transition-all duration-150 btn-press`}
          >
            {state === 'downloading' ? (
              <><Loader2 className="w-4 h-4 animate-spin" />{t('podcast.downloading', { current: dlProgress?.current || 0, total: dlProgress?.total || 0 })}</>
            ) : (
              <><Download className="w-4 h-4" />{t('podcast.downloadSelected', { count: selected.size })}</>
            )}
          </button>
        </div>
      )}

      {/* Download Progress Overlay */}
      {isLocked && (
        <DownloadOverlay
          title="正在下载播客…"
          detail={dlProgress?.title || (dlProgress ? `${dlProgress.current}/${dlProgress.total}` : '')}
          current={dlProgress?.current || 0}
          total={dlProgress?.total || 0}
          iconColor={platform === 'xiaoyuzhou' ? '#059669' : '#9333ea'}
          iconBgColor={platform === 'xiaoyuzhou' ? 'rgb(5 150 105 / 0.1)' : 'rgb(147 51 234 / 0.1)'}
          progressColor={platform === 'xiaoyuzhou' ? '#059669' : '#9333ea'}
          onCancel={handleCancel}
        />
      )}

      {/* Done */}
      {state === 'done' && doneMsg && (
        <div className="flex items-center gap-2 text-green-600 text-sm bg-green-50 border border-green-100/60 rounded-lg p-3">
          <CheckCircle className="w-4 h-4 flex-shrink-0" />
          {doneMsg}
        </div>
      )}

      {/* Error */}
      {state === 'error' && (
        <div className="flex items-center gap-2 text-red-500 text-sm bg-red-50 border border-red-100/60 rounded-lg p-3 shadow-soft">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* Help */}
      {!podcast && state === 'idle' && (
        <div className="text-xs text-gray-400 space-y-1 bg-surface-sunken rounded-xl p-3.5">
          <p>{t('podcast.supportedFormats')}</p>
          <ul className="list-disc list-inside space-y-0.5">
            <li>{t('podcast.formatApple')}</li>
            <li>{t('podcast.formatXyz1')}</li>
            <li>{t('podcast.formatXyz2')}</li>
          </ul>
        </div>
      )}
    </div>
  );
}
