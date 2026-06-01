import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { Tv2, Loader2, CheckCircle, AlertCircle, ChevronDown, ChevronUp, Download, User, PlayCircle, Heart, Layers, X, Info, Brain } from 'lucide-react';
import type { ImportProgress } from '@/lib/types';
import { t } from '@/lib/i18n';
import { isBilibiliUrl, parseBilibiliUrl, isBilibiliSpaceUrl, parseBilibiliSpaceUrl } from '@/services/bilibili';
import type { BilibiliVideoItem, BilibiliSourceInfo } from '@/services/bilibili';
import { getOpState, clearOpState } from '@/services/op-state';
import { PROMPT_STYLES } from '@/services/ai-polish';
import { getSettings } from '@/lib/settings';
import { MindMap, useMindMapGenerator } from '@/components/MindMap';
import { fetchVideoSubtitle, mergeBilibiliSubtitles } from '@/services/bilibili';

type State = 'idle' | 'loading' | 'loaded' | 'fetching' | 'downloading' | 'done' | 'error';
type FetchMode = 'single' | 'space' | 'favorite' | 'series' | 'season';
type ExportMode = 'separate' | 'merged';
type OutputFormat = 'md' | 'txt' | 'json' | 'srt';

const PAGE_SIZE = 100;
const OUTPUT_FORMATS: { value: OutputFormat; label: string }[] = [
  { value: 'md', label: '.md' },
  { value: 'txt', label: '.txt' },
  { value: 'json', label: '.json' },
  { value: 'srt', label: '.srt' },
];

const MODE_OPTIONS: { value: FetchMode; icon: typeof Tv2; labelKey: Parameters<typeof t>[0] }[] = [
  { value: 'single', icon: Tv2, labelKey: 'bilibili.modeSingle' },
  { value: 'season', icon: PlayCircle, labelKey: 'bilibili.modeSeason' },
  { value: 'series', icon: Layers, labelKey: 'bilibili.modeSeries' },
  { value: 'favorite', icon: Heart, labelKey: 'bilibili.modeFavorite' },
  { value: 'space', icon: User, labelKey: 'bilibili.modeSpace' },
];

function modeIcon(mode: FetchMode) {
  return MODE_OPTIONS.find(o => o.value === mode)?.icon || Tv2;
}

interface Props {
  initialUrl?: string;
  onProgress: (progress: ImportProgress | null) => void;
  fetchTrigger?: number;
}

function detectFetchMode(url: string): FetchMode {
  if (isBilibiliSpaceUrl(url)) return 'space';
  if (/bilibili\.com\/list\/(watchlater|fav)/.test(url)) return 'favorite';
  if (/bilibili\.com\/list\/ml/.test(url)) return 'favorite';
  if (/bilibili\.com\/video\/.*\?p=\d+/.test(url)) return 'season';
  if (/bilibili\.com\/video\/BV/.test(url)) return 'single';
  return 'single';
}

function refineMode(source: BilibiliSourceInfo, _videos: BilibiliVideoItem[]): FetchMode {
  if (source.type === 'series') return 'series';
  if (source.isSeries) return 'season';
  return 'single';
}

export function BilibiliSummary({ initialUrl, onProgress, fetchTrigger }: Props) {
  const [url, setUrl] = useState(initialUrl || '');
  const [state, setState] = useState<State>('idle');
  const [error, setError] = useState('');
  const [source, setSource] = useState<BilibiliSourceInfo | null>(null);
  const [videos, setVideos] = useState<BilibiliVideoItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [displayCount, setDisplayCount] = useState(PAGE_SIZE);
  const [doneMsg, setDoneMsg] = useState('');

  const [fetchMode, setFetchMode] = useState<FetchMode>('single');
  const [exportMode, setExportMode] = useState<ExportMode>('merged');
  const [outputFormat, setOutputFormat] = useState<OutputFormat>('md');
  const [aiPolish, setAiPolish] = useState(false);
  const [aiPromptStyle, setAiPromptStyle] = useState('smooth');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [listHeight, setListHeight] = useState(144);
  const [listExpanded, setListExpanded] = useState(true);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [dlProgress, setDlProgress] = useState<{ current: number; total: number; title?: string } | null>(null);
  const abortRef = useRef<{ port?: chrome.runtime.Port; cancel: () => void }>({ cancel: () => {} });

  const { state: mindMapState, mindMapText, error: mindMapError, generate: generateMindMap, setState: setMindMapState } = useMindMapGenerator();
  const [showMindMap, setShowMindMap] = useState(false);

  const isLocked = state === 'downloading';
  const isLockedRef = useRef(false);
  isLockedRef.current = isLocked;

  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [dropdownOpen]);

  const displayedVideos = useMemo(() => videos.slice(0, displayCount), [videos, displayCount]);
  const canLoadMore = displayCount < videos.length;

  const videoKey = (v: BilibiliVideoItem) => `${v.bvid}-${v.page}`;

  const doFetch = useCallback((mode: FetchMode) => {
    if (!url && !initialUrl) return;

    const targetUrl = url || initialUrl || '';
    if (!targetUrl) { setError(t('bilibili.enterLink')); setState('error'); return; }

    setState('loading');
    setError('');
    setSource(null);
    setVideos([]);
    setDoneMsg('');
    setDisplayCount(PAGE_SIZE);

    if (mode === 'space') {
      if (!isBilibiliSpaceUrl(targetUrl) || !parseBilibiliSpaceUrl(targetUrl)) {
        setError(t('bilibili.spaceUnrecognized')); setState('error'); return;
      }
      const mid = parseBilibiliSpaceUrl(targetUrl);
      chrome.runtime.sendMessage(
        { type: 'FETCH_BILIBILI_SPACE', mid: mid! },
        (resp) => {
          if (resp?.success && resp.data) {
            const data = resp.data as { source: BilibiliSourceInfo; videos: BilibiliVideoItem[] };
            setSource(data.source);
            setVideos(data.videos);
            setSelected(new Set(data.videos.map(videoKey)));
            setDisplayCount(PAGE_SIZE);
            setFetchMode(refineMode(data.source, data.videos));
            setState('loaded');
          } else {
            setState('error');
            setError(resp?.error || t('bilibili.fetchFailed'));
          }
        },
      );
    } else {
      if (!isBilibiliUrl(targetUrl) || !parseBilibiliUrl(targetUrl)) {
        setError(t('bilibili.unrecognized')); setState('error'); return;
      }
      chrome.runtime.sendMessage(
        { type: 'FETCH_BILIBILI', url: targetUrl },
        (resp) => {
          if (resp?.success && resp.data) {
            const data = resp.data as { source: BilibiliSourceInfo; videos: BilibiliVideoItem[] };
            setSource(data.source);
            setVideos(data.videos);
            setSelected(new Set(data.videos.map(videoKey)));
            setDisplayCount(PAGE_SIZE);
            setFetchMode(refineMode(data.source, data.videos));
            setState('loaded');
          } else {
            setState('error');
            setError(resp?.error || t('bilibili.fetchFailed'));
          }
        },
      );
    }
  }, [t, url, initialUrl]);

  const handleFetch = useCallback(() => {
    doFetch(fetchMode);
  }, [doFetch, fetchMode]);

  useEffect(() => {
    getOpState().then((op) => {
      if (op?.active) {
        setState('downloading');
        setDlProgress({ current: op.current || 0, total: op.total || 0, title: op.title || '' });
      }
    });
  }, []);

  const lastAutoUrl = useRef<string | null>(null);
  useEffect(() => {
    if (!initialUrl) return;
    if (isLockedRef.current) return;
    getOpState().then((op) => {
      if (op?.active) return;
      if (isLockedRef.current) return;
      if (lastAutoUrl.current === initialUrl) return;
      lastAutoUrl.current = initialUrl;
      setUrl(initialUrl);
      const mode = detectFetchMode(initialUrl);
      setFetchMode(mode);
      doFetch(mode);
    });
  }, [initialUrl]);

  useEffect(() => {
    if (isLockedRef.current) return;
    if (fetchTrigger && fetchTrigger > 0 && initialUrl) {
      lastAutoUrl.current = null;
      setUrl(initialUrl);
      const mode = detectFetchMode(initialUrl);
      setFetchMode(mode);
      doFetch(mode);
    }
  }, [fetchTrigger]);

  useEffect(() => {
    getSettings().then((s) => {
      if (s.ai.promptStyle) setAiPromptStyle(s.ai.promptStyle);
    });
  }, []);

  const getSelectedVideos = () => videos.filter(v => selected.has(videoKey(v)));

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
    const toProcess = getSelectedVideos();
    if (toProcess.length === 0) { setError(t('bilibili.selectAtLeastOne')); setState('error'); return; }

    setState('downloading');
    setError('');
    setDoneMsg('');
    setDlProgress({ current: 0, total: toProcess.length });

    const msgType = exportMode === 'merged' ? 'BILIBILI_DOWNLOAD_MERGED' : 'BILIBILI_DOWNLOAD_SEPARATE';
    const port = chrome.runtime.connect({ name: 'bilibili-download' });
    abortRef.current = { port, cancel: () => {} };
    let cancelled = false;

    port.postMessage({
      type: msgType,
      videos: toProcess,
      ownerName: source?.owner || '',
      desc: source?.desc || '',
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
        setError(String(msg.error || t('bilibili.fetchFailed')));
      }
    });

    port.onDisconnect.addListener(() => {
      abortRef.current = { cancel: () => {} };
    });

    abortRef.current.cancel = () => { cancelled = true; };
  };

  const toggleVideo = (key: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(displayedVideos.map(videoKey)));
  const selectNone = () => setSelected(new Set());

  const isWorking = state === 'loading' || state === 'downloading' || state === 'fetching';

  return (
    <div className="space-y-5">
      {/* Input */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2 flex items-center gap-1.5">
          <Tv2 className="w-4 h-4 text-[#00a1d6]" />
          {t('bilibili.link')}
        </label>
        <div className="flex gap-2">
        <div className="flex-1 flex items-stretch" ref={dropdownRef}>
          <div className="relative flex-shrink-0">
            <button
              onClick={() => setDropdownOpen(!dropdownOpen)}
              disabled={isLocked}
              className="flex flex-col items-center justify-center w-10 h-full border border-gray-200/60 rounded-l-lg hover:bg-gray-50 transition-colors duration-150 pt-1 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {(() => { const Icon = modeIcon(fetchMode); return <Icon className="w-4 h-4 text-[#00a1d6]" />; })()}
              <ChevronDown className="w-2.5 h-2.5 text-gray-400 -mt-0.5" />
            </button>
            {dropdownOpen && (
              <div className="absolute top-full left-0 mt-1 bg-white border border-gray-200/60 rounded-lg shadow-lg z-20 min-w-[130px] py-1">
                {MODE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => {
                      setFetchMode(opt.value);
                      setSource(null);
                      setVideos([]);
                      setState('idle');
                      setDropdownOpen(false);
                    }}
                    className={`flex items-center gap-2 w-full px-3 py-2 text-xs transition-colors duration-100 ${
                      fetchMode === opt.value
                        ? 'bg-[#00a1d6]/10 text-[#00a1d6] font-medium'
                        : 'text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    <opt.icon className="w-3.5 h-3.5 flex-shrink-0" />
                    {t(opt.labelKey)}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex-1 relative">
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !isWorking) handleFetch(); }}
              readOnly={isLocked}
              placeholder={fetchMode === 'space' ? t('bilibili.spacePlaceholder') : t('bilibili.placeholder')}
              className="w-full h-full pl-3 pr-3 py-2 border-y border-r border-gray-200/60 text-sm focus:outline-none focus:ring-2 focus:ring-[#00a1d6]/40 focus:ring-inset placeholder:text-gray-400/70 rounded-r-lg"
            />
          </div>
        </div>

        <button
          onClick={handleFetch}
          disabled={!url || isWorking}
          className="px-4 py-1.5 bg-[#00a1d6] hover:bg-[#0090c0] text-white text-xs rounded-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1 shadow-btn hover:shadow-btn-hover transition-all duration-150 btn-press flex-shrink-0"
        >
          {state === 'loading' ? (
            <><Loader2 className="w-3 h-3 animate-spin" />{t('bilibili.querying')}</>
          ) : (
            <>{(() => { const Icon = modeIcon(fetchMode); return <Icon className="w-3 h-3" />; })()}{t('bilibili.query')}</>
          )}
        </button>
      </div>
      </div>

      {/* Video Info */}
      {source && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2 flex items-center gap-1.5">
            <Info className="w-4 h-4 text-[#00a1d6]" />
            {t('bilibili.videoInfo')}
          </label>
          <div className="border border-sky-100/60 rounded-lg overflow-hidden shadow-soft">
            <div className="bg-sky-50 p-3 flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-[#00a1d6]/10 flex items-center justify-center flex-shrink-0">
                <Tv2 className="w-5 h-5 text-[#00a1d6]" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-sky-900 truncate">{source.title}</p>
                <p className="text-xs text-sky-600">
                  {source.owner && <span className="mr-2">UP主：{source.owner}</span>}
                  {source.type === 'series' ? (
                    <span className="bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded text-[10px] font-bold mr-2">合集</span>
                  ) : source.isSeries && videos.length > 1 ? (
                    <span className="bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded text-[10px] font-bold mr-2">分P</span>
                  ) : null}
                  <span className="font-mono tabular-nums">{source.videoCount}</span> {source.isSeries ? t('bilibili.parts') : t('bilibili.singleVideo')}
                </p>
              </div>
            </div>

            {videos.length > 1 && (
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
                      {t('bilibili.selectedParts', { selected: selected.size, total: displayedVideos.length })}
                    </span>
                  </div>
                  <div className="flex gap-2 text-xs">
                    <button onClick={selectAll} className="text-[#00a1d6] hover:underline">{t('selectAll')}</button>
                    <button onClick={selectNone} className="text-gray-400 hover:underline">{t('deselectAll')}</button>
                  </div>
                </div>
                {listExpanded && (
                  <>
                    <div
                      className="overflow-y-auto bg-white"
                      style={{ maxHeight: listHeight }}
                    >
                      {displayedVideos.map((video) => {
                        const key = videoKey(video);
                        return (
                          <label
                            key={key}
                            className="flex items-start gap-3 p-2 hover:bg-gray-50 cursor-pointer border-b border-gray-100 last:border-b-0 transition-colors duration-150"
                          >
                            <input
                              type="checkbox"
                              checked={selected.has(key)}
                              onChange={() => toggleVideo(key)}
                              className="mt-1 rounded border-gray-300 text-[#00a1d6] focus:ring-[#00a1d6]"
                            />
                            <div className="flex-1 min-w-0">
                              <p className="text-sm text-gray-700 line-clamp-1">
                                <span className="text-gray-400 mr-1">P{video.page}</span>
                                {video.part || video.title}
                              </p>
                              {video.duration && (
                                <p className="text-xs text-gray-400 mt-0.5">
                                  {Math.floor(video.duration / 60)}:{String(video.duration % 60).padStart(2, '0')}
                                </p>
                              )}
                            </div>
                          </label>
                        );
                      })}
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
              onClick={() => setDisplayCount(c => Math.min(c + PAGE_SIZE, videos.length))}
              className="w-full mt-2 py-1.5 text-xs text-[#00a1d6] hover:text-[#0090c0] hover:bg-sky-50 border border-sky-200/60 rounded-lg flex items-center justify-center gap-1 transition-colors duration-150"
            >
              <ChevronDown className="w-3 h-3" />加载更多（{videos.length - displayCount} 个）
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
              const results: { markdown: string | null; partLabel: string }[] = [];
              for (const v of selectedVideos) {
                const result = await fetchVideoSubtitle(v, source?.owner || '', source?.desc || '');
                results.push({ markdown: result.markdown, partLabel: v.part || v.title });
              }
              const partsWithContent = results.filter(r => r.markdown);
              if (partsWithContent.length === 0) {
                setMindMapState('error');
                setShowMindMap(false);
                return;
              }
              const subtitleText = partsWithContent
                .map(r => `【${r.partLabel}】\n${r.markdown?.replace(/^#.*\n?/gm, '').trim() || ''}`)
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

      {videos.length > 0 && (
        <div className="space-y-3">
          <label className="block text-sm font-medium text-gray-700 flex items-center gap-1.5">
            <Download className="w-4 h-4 text-[#00a1d6]" />
            {t('bilibili.outputType')}
          </label>
          <div className="flex items-center gap-1.5">
            <div className="flex rounded-lg border border-gray-200/60 overflow-hidden">
              <button
                onClick={() => setExportMode('separate')}
                className={`px-2.5 py-1 text-[11px] font-medium transition-colors duration-150 ${
                  exportMode === 'separate'
                    ? 'bg-[#00a1d6] text-white'
                    : 'bg-white text-gray-400 hover:text-gray-500'
                }`}
              >
                {t('bilibili.separate')}
              </button>
              <button
                onClick={() => setExportMode('merged')}
                className={`px-2.5 py-1 text-[11px] font-medium transition-colors duration-150 border-l border-gray-200/60 ${
                  exportMode === 'merged'
                    ? 'bg-[#00a1d6] text-white'
                    : 'bg-white text-gray-400 hover:text-gray-500'
                }`}
              >
                {t('bilibili.merged')}
              </button>
            </div>
            <select
              value={outputFormat}
              onChange={(e) => setOutputFormat(e.target.value as OutputFormat)}
              className="text-[11px] border border-gray-200/60 rounded-lg px-2 py-1 bg-white text-gray-600 focus:outline-none focus:ring-1 focus:ring-[#00a1d6]/40"
            >
              {OUTPUT_FORMATS.map((f) => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </select>
            <div className="flex-1" />
            <span className="text-[11px] text-gray-500">{t('bilibili.aiPolish')}</span>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={aiPolish}
                onChange={(e) => setAiPolish(e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-7 h-4 bg-gray-200 peer-focus:outline-none peer-focus:ring-1 peer-focus:ring-[#00a1d6]/40 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-[#00a1d6]"></div>
            </label>
          </div>

          {aiPolish && (
            <div>
              <p className="text-xs font-medium text-gray-600 mb-1.5">{t('bilibili.promptStyle')}</p>
              <div className="flex flex-wrap gap-1.5">
                {PROMPT_STYLES.map((style) => (
                  <button
                    key={style.value}
                    onClick={() => setAiPromptStyle(style.value)}
                    className={`px-2.5 py-1 text-[11px] rounded-full border transition-colors duration-150 ${
                      aiPromptStyle === style.value
                        ? 'bg-[#00a1d6] text-white border-[#00a1d6]'
                        : 'bg-white text-gray-500 border-gray-200 hover:border-[#00a1d6]/40 hover:text-[#00a1d6]'
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
                      ? 'bg-[#00a1d6] text-white border-[#00a1d6]'
                      : 'bg-white text-gray-500 border-gray-200 hover:border-[#00a1d6]/40 hover:text-[#00a1d6]'
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
            className="w-full py-2.5 bg-sky-500 hover:bg-sky-600 text-white text-sm rounded-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-btn hover:shadow-btn-hover transition-all duration-150 btn-press"
          >
            {state === 'downloading' ? (
              <><Loader2 className="w-4 h-4 animate-spin" />{t('bilibili.fetchingSubtitles')}</>
            ) : (
              <><Download className="w-4 h-4" />{t('bilibili.downloadOneClick')}（{selected.size}）</>
            )}
          </button>
        </div>
      )}

      {isLocked && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-xl border border-gray-100 p-6 w-[280px] text-center space-y-4 animate-fade-in">
            <div className="w-12 h-12 mx-auto rounded-full bg-[#00a1d6]/10 flex items-center justify-center">
              <Download className="w-6 h-6 text-[#00a1d6]" />
            </div>
            <div>
              <p className="text-sm font-medium text-gray-800">正在导出字幕…</p>
              {dlProgress && (
                <p className="text-xs text-gray-400 mt-1">
                  {dlProgress.title || `${dlProgress.current}/${dlProgress.total}`}
                </p>
              )}
            </div>
            {dlProgress && dlProgress.total > 0 && (
              <div className="w-full bg-gray-100 rounded-full h-1.5 overflow-hidden">
                <div
                  className="bg-[#00a1d6] h-1.5 rounded-full transition-all duration-500"
                  style={{ width: `${Math.round((dlProgress.current / dlProgress.total) * 100)}%` }}
                />
              </div>
            )}
            <div className="flex items-center justify-center gap-1 text-[#00a1d6]">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span className="text-xs text-gray-400">处理中…</span>
            </div>
            <button
              onClick={handleCancel}
              className="w-full py-2 text-xs font-medium text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg border border-gray-200 transition-colors duration-150 flex items-center justify-center gap-1"
            >
              <X className="w-3 h-3" />
              取消操作
            </button>
          </div>
        </div>
      )}

      {state === 'done' && doneMsg && (
        <div className="flex items-center gap-2 text-green-600 text-sm bg-green-50 border border-green-100/60 rounded-lg p-3">
          <CheckCircle className="w-4 h-4 flex-shrink-0" />
          {doneMsg}
        </div>
      )}

      {state === 'error' && (
        <div className="flex items-center gap-2 text-red-500 text-sm bg-red-50 border border-red-100/60 rounded-lg p-3 shadow-soft">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {!source && state === 'idle' && (
        <div className="text-xs text-gray-400 space-y-2 bg-surface-sunken rounded-xl p-3.5">
          <p>{t('bilibili.supportedFormats')}</p>
          <ul className="list-disc list-inside space-y-0.5">
            <li>{t('bilibili.formatVideo')}</li>
            <li>{t('bilibili.formatPart')}</li>
            <li>个人主页: space.bilibili.com/xxx</li>
          </ul>
          <p className="flex items-center gap-1 text-amber-500">
            <AlertCircle className="w-3 h-3 flex-shrink-0" />
            {t('bilibili.apiNote')}
          </p>
        </div>
      )}
    </div>
  );
}
