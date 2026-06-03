import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { Youtube, Loader2, CheckCircle, AlertCircle, PlayCircle, ListVideo, User, ChevronDown, ChevronUp, Download, X, Info, Brain } from 'lucide-react';
import type { ImportProgress, YouTubeResult, YouTubeVideoItem, YouTubeSourceInfo } from '@/lib/types';
import { t } from '@/lib/i18n';
import { isYouTubeUrl, parseYouTubeUrl, fetchYouTubeTranscript } from '@/services/youtube';
import { getOpState, clearOpState } from '@/services/op-state';
import { PROMPT_STYLES } from '@/services/ai-polish';
import { getSettings } from '@/lib/settings';
import { MindMap, useMindMapGenerator } from '@/components/MindMap';
import { DownloadOverlay } from '@/components/DownloadOverlay';

type State = 'idle' | 'loading' | 'loaded' | 'downloading' | 'done' | 'error';
type ExportMode = 'separate' | 'merged';

const PAGE_SIZE = 100;

const sourceIcons = {
  video: PlayCircle,
  playlist: ListVideo,
  channel: User,
};

interface Props {
  initialUrl?: string;
  onProgress: (progress: ImportProgress | null) => void;
  fetchTrigger?: number;
}

export function YouTubeSummary({ initialUrl, onProgress, fetchTrigger }: Props) {
  const [url, setUrl] = useState(initialUrl || '');
  const [state, setState] = useState<State>('idle');
  const [error, setError] = useState('');
  const [source, setSource] = useState<YouTubeSourceInfo | null>(null);
  const [videos, setVideos] = useState<YouTubeVideoItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [continuation, setContinuation] = useState<string | undefined>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [displayCount, setDisplayCount] = useState(PAGE_SIZE);
  const [doneMsg, setDoneMsg] = useState('');

  const [exportMode, setExportMode] = useState<ExportMode>('merged');
  const [aiPolish, setAiPolish] = useState(true);
  const [aiPromptStyle, setAiPromptStyle] = useState('smooth');
  const [listHeight, setListHeight] = useState(144);
  const [listExpanded, setListExpanded] = useState(true);
  const [dlProgress, setDlProgress] = useState<{ current: number; total: number; title?: string } | null>(null);
  const abortRef = useRef<{ port?: chrome.runtime.Port; cancel: () => void }>({ cancel: () => {} });

  const { state: mindMapState, mindMapText, error: mindMapError, generate: generateMindMap, setState: setMindMapState } = useMindMapGenerator();
  const [showMindMap, setShowMindMap] = useState(false);

  const isLocked = state === 'downloading';
  const isLockedRef = useRef(false);
  isLockedRef.current = isLocked;

  const displayedVideos = useMemo(() => videos.slice(0, displayCount), [videos, displayCount]);
  const canLoadMore = displayCount < videos.length || !!continuation;

  const urlType = useMemo(() => {
    if (!url || !isYouTubeUrl(url)) return 'unknown';
    return parseYouTubeUrl(url).type;
  }, [url]);

  const isSingleVideo = urlType === 'video';
  const SourceIcon = sourceIcons[urlType as keyof typeof sourceIcons] || Youtube;

  const getSelectedVideos = () => videos.filter(v => selected.has(v.id));

  useEffect(() => {
    getOpState().then((op) => {
      if (op?.active) {
        setState('downloading');
        setDlProgress({ current: op.current || 0, total: op.total || 0, title: op.title || '' });
      }
    });
  }, []);

  const handleFetch = useCallback(() => {
    if (!url) { setError(t('youtube.enterLink')); setState('error'); return; }
    if (urlType === 'unknown') { setError(t('youtube.unrecognized')); setState('error'); return; }

    setState('loading');
    setError('');
    setSource(null);
    setVideos([]);
    setContinuation(undefined);
    setDisplayCount(PAGE_SIZE);
    setDoneMsg('');

    chrome.runtime.sendMessage(
      { type: 'FETCH_YOUTUBE', url },
      (resp) => {
        if (resp?.success && resp.data) {
          const data = resp.data as YouTubeResult;
          setSource(data.source);
          setVideos(data.videos);
          setSelected(new Set(data.videos.slice(0, PAGE_SIZE).map((v) => v.id)));
          setContinuation(data.continuation);
          setDisplayCount(PAGE_SIZE);
          setState('loaded');
        } else {
          setState('error');
          setError(resp?.error || t('youtube.fetchFailed'));
        }
      },
    );
  }, [url, urlType, t]);

  const revealNextPage = (allVideos: YouTubeVideoItem[]) => {
    const nextCount = Math.min(displayCount + PAGE_SIZE, allVideos.length);
    const newlyRevealed = allVideos.slice(displayCount, nextCount);
    setSelected((prev) => {
      const next = new Set(prev);
      newlyRevealed.forEach((v) => next.add(v.id));
      return next;
    });
    setDisplayCount(nextCount);
  };

  const handleLoadMore = () => {
    if (loadingMore) return;

    if (displayCount < videos.length) {
      revealNextPage(videos);
      return;
    }

    if (!continuation) return;
    setLoadingMore(true);

    chrome.runtime.sendMessage(
      { type: 'FETCH_YOUTUBE_MORE', continuation },
      (resp) => {
        setLoadingMore(false);
        if (resp?.success && resp.data) {
          const data = resp.data as { videos: YouTubeVideoItem[]; continuation?: string };
          const merged = [...videos, ...data.videos];
          setVideos(merged);
          setContinuation(data.continuation);
          revealNextPage(merged);
        }
      },
    );
  };

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
    const toProcess = isSingleVideo ? videos : getSelectedVideos();
    if (toProcess.length === 0) { setError(t('youtube.selectAtLeastOne')); setState('error'); return; }

    setState('downloading');
    setError('');
    setDoneMsg('');
    setDlProgress({ current: 0, total: toProcess.length });

    const msgType = exportMode === 'merged' ? 'YOUTUBE_DOWNLOAD_MERGED' : 'YOUTUBE_DOWNLOAD_SEPARATE';
    const port = chrome.runtime.connect({ name: 'youtube-download' });
    abortRef.current = { port, cancel: () => {} };
    let cancelled = false;

    port.postMessage({
      type: msgType,
      videos: toProcess,
      source: source,
      aiPolish,
      promptStyle: aiPromptStyle,
    });

    port.onMessage.addListener((msg) => {
      if (cancelled) return;
      if (msg.phase === 'downloading') {
        setDlProgress({ current: Number(msg.current), total: Number(msg.total), title: String(msg.title || '') });
      } else if (msg.phase === 'polishing') {
        const cur = Number(msg.current || 0);
        const tot = Number(msg.total || 0);
        const pct = tot > 0 ? Math.round((cur / tot) * 100) : 0;
        setDlProgress({ current: cur, total: tot, title: `AI 润色 ${pct}% (${cur}/${tot})` });
      } else if (msg.phase === 'done') {
        setDlProgress(null);
        port.disconnect();
        abortRef.current = { cancel: () => {} };
        if (msg.downloaded !== undefined) {
          const { downloaded, skipped } = msg as any;
          setDoneMsg(skipped > 0
            ? `已下载 ${downloaded} 个字幕文件，${skipped} 个无字幕`
            : `已下载 ${downloaded} 个字幕文件`
          );
        } else {
          setDoneMsg(`已合并下载 ${toProcess.length} 个视频内容`);
        }
        setState('done');
      } else if (msg.phase === 'error') {
        setDlProgress(null);
        port.disconnect();
        abortRef.current = { cancel: () => {} };
        setState('error');
        setError(String(msg.error || t('youtube.fetchFailed')));
      }
    });

    port.onDisconnect.addListener(() => {
      abortRef.current = { cancel: () => {} };
    });

    abortRef.current.cancel = () => { cancelled = true; };
  };

  const toggleVideo = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(displayedVideos.map((v) => v.id)));
  const selectNone = () => setSelected(new Set());

  const lastAutoUrl = useRef<string | null>(null);
  useEffect(() => {
    if (!initialUrl) return;
    if (isLockedRef.current) return;
    if (lastAutoUrl.current === initialUrl) return;
    lastAutoUrl.current = initialUrl;
    setUrl(initialUrl);
    if (isYouTubeUrl(initialUrl)) handleFetch();
  }, [initialUrl]);

  useEffect(() => {
    if (isLockedRef.current) return;
    if (fetchTrigger && fetchTrigger > 0 && initialUrl && isYouTubeUrl(initialUrl)) {
      lastAutoUrl.current = null;
      setUrl(initialUrl);
      handleFetch();
    }
  }, [fetchTrigger]);

  useEffect(() => {
    getSettings().then((s) => {
      if (s.ai.promptStyle) setAiPromptStyle(s.ai.promptStyle);
    });
  }, []);

  const isWorking = state === 'loading' || state === 'downloading';

  return (
    <div className="space-y-5">
      {/* Input */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2 flex items-center gap-1.5">
          <Youtube className="w-4 h-4 text-red-500" />
          {t('youtube.link')}
        </label>
        <div className="flex gap-2">
          <div className="flex-1 relative">
            <SourceIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !isWorking) handleFetch(); }}
              readOnly={isLocked}
              placeholder={t('youtube.placeholder')}
              className="w-full pl-10 pr-3 py-2 border border-gray-200/60 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-red-500/40 focus:border-transparent placeholder:text-gray-400/70"
            />
          </div>
          <button
            onClick={handleFetch}
            disabled={!url || isWorking}
            className="px-4 py-1.5 bg-red-500 hover:bg-red-600 text-white text-xs rounded-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1 shadow-btn hover:shadow-btn-hover transition-all duration-150 btn-press flex-shrink-0"
          >
            {state === 'loading' ? (
              <><Loader2 className="w-3 h-3 animate-spin" />{t('youtube.querying')}</>
            ) : (
              <><Youtube className="w-3 h-3" />{t('youtube.query')}</>
            )}
          </button>
        </div>
      </div>

      {/* Video Info */}
      {source && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2 flex items-center gap-1.5">
            <Info className="w-4 h-4 text-red-500" />
            {t('youtube.videoInfo')}
          </label>
          <div className="border border-red-100/60 rounded-lg overflow-hidden shadow-soft">
            <div className="bg-red-50 p-3 flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-red-100 flex items-center justify-center flex-shrink-0">
                <SourceIcon className="w-5 h-5 text-red-500" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-red-900 truncate">{source.title}</p>
                <p className="text-xs text-red-600">
                  {source.type === 'video' ? (
                    <span>{t('youtube.singleVideo')}</span>
                  ) : (
                    <span className="font-mono tabular-nums">{source.videoCount}</span>
                  )}
                  {source.type !== 'video' && <span className="ml-0.5">{t('youtube.videos')}</span>}
                </p>
              </div>
            </div>

            {displayedVideos.length > 1 && (
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
                      {t('youtube.selectedVideos', { selected: selected.size, total: displayedVideos.length })}
                    </span>
                  </div>
                  <div className="flex gap-2 text-xs">
                    <button onClick={selectAll} className="text-red-500 hover:underline">{t('selectAll')}</button>
                    <button onClick={selectNone} className="text-gray-400 hover:underline">{t('deselectAll')}</button>
                  </div>
                </div>
                {listExpanded && (
                  <>
                    <div
                      className="overflow-y-auto bg-white"
                      style={{ maxHeight: listHeight }}
                    >
                      {displayedVideos.map((video) => (
                        <label
                          key={video.id}
                          className="flex items-start gap-3 p-2 hover:bg-gray-50 cursor-pointer border-b border-gray-100 last:border-b-0 transition-colors duration-150"
                        >
                          <input
                            type="checkbox"
                            checked={selected.has(video.id)}
                            onChange={() => toggleVideo(video.id)}
                            className="mt-1 rounded border-gray-300 text-red-500 focus:ring-red-500"
                          />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-gray-700 line-clamp-1">{video.title}</p>
                            {video.publishedAt && (
                              <p className="text-xs text-gray-400 mt-0.5">{video.publishedAt}</p>
                            )}
                          </div>
                        </label>
                      ))}
                    </div>
                    <div
                      className="flex items-center justify-center h-3 bg-gray-50 border-t border-gray-100 cursor-ns-resize hover:bg-gray-100 transition-colors group"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        const startY = e.clientY;
                        const startH = listHeight;
                        const onMove = (ev: MouseEvent) => {
                          setListHeight(Math.max(60, Math.min(600, startH + (ev.clientY - startY))));
                        };
                        const onUp = () => {
                          document.removeEventListener('mousemove', onMove);
                          document.removeEventListener('mouseup', onUp);
                        };
                        document.addEventListener('mousemove', onMove);
                        document.addEventListener('mouseup', onUp);
                      }}
                    >
                      <div className="w-8 h-0.5 rounded-full bg-gray-300 group-hover:bg-gray-400 transition-colors" />
                    </div>
                  </>
                )}
              </>
            )}
          </div>

          {canLoadMore && (
            <button
              onClick={handleLoadMore}
              disabled={loadingMore}
              className="w-full mt-2 py-1.5 text-xs text-red-500 hover:text-red-600 hover:bg-red-50 border border-red-200/60 rounded-lg flex items-center justify-center gap-1 transition-colors duration-150 disabled:opacity-50"
            >
              {loadingMore ? (
                <><Loader2 className="w-3 h-3 animate-spin" />{t('youtube.loadingMore')}</>
              ) : (
                <><ChevronDown className="w-3 h-3" />加载更多（{videos.length - displayCount} 个）</>
              )}
            </button>
          )}
        </div>
      )}

      {/* Mind Map */}
      {videos.length > 0 && !showMindMap && (
        <button
          onClick={async () => {
            setShowMindMap(true);
            setMindMapState('loading');
            try {
              const selectedVideos = getSelectedVideos();
              const transcripts: { title: string; text: string }[] = [];
              for (const v of selectedVideos) {
                const t = await fetchYouTubeTranscript(v.id);
                if (t.success && t.markdown) {
                  transcripts.push({ title: v.title, text: t.markdown.replace(/^#.*\n?/gm, '').trim() });
                }
              }
              if (transcripts.length === 0) {
                setMindMapState('error');
                setShowMindMap(false);
                return;
              }
              const subtitleText = transcripts
                .map(r => `【${r.title}】\n${r.text}`)
                .join('\n\n');
              generateMindMap({ subtitleText, sourceTitle: source?.title });
            } catch {
              setMindMapState('error');
            }
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
      {videos.length > 0 && (
        <div className="border-t border-gray-100 pt-4 space-y-3">
          <label className="block text-sm font-medium text-gray-700 flex items-center gap-1.5">
            <Download className="w-4 h-4 text-red-500" />
            {t('youtube.outputMode')}
          </label>
          <div className="flex items-center gap-1.5">
            <div className="flex rounded-lg border border-gray-200/60 overflow-hidden">
              <button
                onClick={() => setExportMode('separate')}
                className={`px-2.5 py-1 text-[11px] font-medium transition-colors duration-150 ${
                  exportMode === 'separate'
                    ? 'bg-red-500 text-white'
                    : 'bg-white text-gray-400 hover:text-gray-500'
                }`}
              >
                Split
              </button>
              <button
                onClick={() => setExportMode('merged')}
                className={`px-2.5 py-1 text-[11px] font-medium transition-colors duration-150 border-l border-gray-200/60 ${
                  exportMode === 'merged'
                    ? 'bg-red-500 text-white'
                    : 'bg-white text-gray-400 hover:text-gray-500'
                }`}
              >
                Merged
              </button>
            </div>
            <span className="text-[11px] text-gray-400">.md</span>
            <div className="flex-1" />
            <span className="text-[11px] text-gray-500">{t('youtube.aiPolish')}</span>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={aiPolish}
                onChange={(e) => setAiPolish(e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-7 h-4 bg-gray-200 peer-focus:outline-none peer-focus:ring-1 peer-focus:ring-red-500/40 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-red-500"></div>
            </label>
          </div>

          {aiPolish && (
            <div>
              <p className="text-xs font-medium text-gray-600 mb-1.5">{t('youtube.promptStyle')}</p>
              <div className="flex flex-wrap gap-1.5">
                {PROMPT_STYLES.map((style) => (
                  <button
                    key={style.value}
                    onClick={() => setAiPromptStyle(style.value)}
                    className={`px-2.5 py-1 text-[11px] rounded-full border transition-colors duration-150 ${
                      aiPromptStyle === style.value
                        ? 'bg-red-500 text-white border-red-500'
                        : 'bg-white text-gray-500 border-gray-200 hover:border-red-300 hover:text-red-500'
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
                      ? 'bg-red-500 text-white border-red-500'
                      : 'bg-white text-gray-500 border-gray-200 hover:border-red-300 hover:text-red-500'
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
            className="w-full py-2.5 bg-red-500 hover:bg-red-600 text-white text-sm rounded-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-btn hover:shadow-btn-hover transition-all duration-150 btn-press"
          >
            {state === 'downloading' ? (
              <><Loader2 className="w-4 h-4 animate-spin" />{t('youtube.downloadingProgress')}</>
            ) : (
              <><Download className="w-4 h-4" />{t('youtube.oneClickDownload')}（{selected.size}）</>
            )}
          </button>
        </div>
      )}

      {/* Download Progress Overlay */}
      {isLocked && (
        <DownloadOverlay
          title="正在下载字幕…"
          detail={dlProgress?.title || (dlProgress ? `${dlProgress.current}/${dlProgress.total}` : '')}
          current={dlProgress?.current || 0}
          total={dlProgress?.total || 0}
          iconColor="#ef4444"
          iconBgColor="rgb(239 68 68 / 0.1)"
          progressColor="#ef4444"
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
      {!source && state === 'idle' && (
        <div className="text-xs text-gray-400 space-y-1 bg-surface-sunken rounded-xl p-3.5">
          <p>{t('youtube.supportedFormats')}</p>
          <ul className="list-disc list-inside space-y-0.5">
            <li>{t('youtube.formatVideo')}</li>
            <li>{t('youtube.formatPlaylist')}</li>
            <li>{t('youtube.formatChannel')}</li>
            <li>{t('youtube.formatShort')}</li>
          </ul>
        </div>
      )}
    </div>
  );
}
