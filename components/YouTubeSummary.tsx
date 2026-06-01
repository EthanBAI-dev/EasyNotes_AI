import { useState, useMemo, useEffect, useRef } from 'react';
import { Youtube, Loader2, CheckCircle, AlertCircle, PlayCircle, ListVideo, User, ChevronDown, ChevronUp, Download, X, Info } from 'lucide-react';
import type { ImportProgress, YouTubeResult, YouTubeVideoItem, YouTubeSourceInfo } from '@/lib/types';
import type { YouTubeTranscriptLine } from '@/services/youtube';
import { t } from '@/lib/i18n';
import { isYouTubeUrl, parseYouTubeUrl, buildYouTubeMarkdown } from '@/services/youtube';
import { polishSubtitlesWithChunks } from '@/services/ai-polish';
import { PROMPT_STYLES } from '@/services/ai-polish';
import { getSettings } from '@/lib/settings';

type State = 'idle' | 'loading' | 'loaded' | 'downloading' | 'done' | 'error';
type TranscriptState = 'idle' | 'loading' | 'loaded' | 'error';

const PAGE_SIZE = 15;

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
  const [results, setResults] = useState<{ success: number; failed: number } | null>(null);
  const [continuation, setContinuation] = useState<string | undefined>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [displayCount, setDisplayCount] = useState(PAGE_SIZE);
  const [doneMsg, setDoneMsg] = useState('');

  const [transcriptState, setTranscriptState] = useState<TranscriptState>('idle');
  const [transcriptError, setTranscriptError] = useState('');
  const [transcriptLines, setTranscriptLines] = useState<YouTubeTranscriptLine[]>([]);
  const [transcriptTitle, setTranscriptTitle] = useState('');
  const [transcriptVideoId, setTranscriptVideoId] = useState('');
  const [aiPolish, setAiPolish] = useState(false);
  const [aiPromptStyle, setAiPromptStyle] = useState('smooth');
  const [exportMode, setExportMode] = useState<'separate' | 'merged'>('separate');
  const [listHeight, setListHeight] = useState(96);
  const [listExpanded, setListExpanded] = useState(true);
  const [dlProgress, setDlProgress] = useState<{ current: number; total: number; title?: string } | null>(null);
  const [dlPhase, setDlPhase] = useState('');

  const displayedVideos = useMemo(() => videos.slice(0, displayCount), [videos, displayCount]);
  const canLoadMore = displayCount < videos.length || !!continuation;

  const urlType = useMemo(() => {
    if (!url || !isYouTubeUrl(url)) return 'unknown';
    return parseYouTubeUrl(url).type;
  }, [url]);

  const isSingleVideo = urlType === 'video';

  const SourceIcon = sourceIcons[urlType as keyof typeof sourceIcons] || Youtube;

  const isLocked = state === 'downloading';

  const handleFetch = () => {
    if (!url) { setError(t('youtube.enterLink')); setState('error'); return; }
    if (urlType === 'unknown') { setError(t('youtube.unrecognized')); setState('error'); return; }

    setState('loading');
    setError('');
    setSource(null);
    setVideos([]);
    setResults(null);
    setContinuation(undefined);
    setDisplayCount(PAGE_SIZE);
    setDoneMsg('');
    setTranscriptState('idle');
    setTranscriptError('');
    setTranscriptLines([]);

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
  };

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

  const handleFetchTranscript = () => {
    if (!isSingleVideo) return;
    const videoId = videos[0]?.id;
    if (!videoId) return;

    setTranscriptState('loading');
    setTranscriptError('');

    chrome.runtime.sendMessage(
      { type: 'FETCH_YOUTUBE_TRANSCRIPT', videoId },
      (resp) => {
        if (resp?.success && resp.data) {
          const data = resp.data as {
            success: boolean;
            title: string;
            videoId: string;
            markdown: string;
            lines: YouTubeTranscriptLine[];
            error?: string;
          };
          if (data.success) {
            setTranscriptLines(data.lines);
            setTranscriptTitle(data.title);
            setTranscriptVideoId(data.videoId);
            setTranscriptState('loaded');
          } else {
            setTranscriptState('error');
            setTranscriptError(data.error || t('youtube.transcriptFailed'));
          }
        } else {
          setTranscriptState('error');
          setTranscriptError(resp?.error || t('youtube.transcriptFailed'));
        }
      },
    );
  };

  const handleDownloadTranscript = async () => {
    if (transcriptLines.length === 0) return;
    setState('downloading');
    setDlProgress({ current: 0, total: aiPolish ? 3 : 1, title: '' });
    setError('');

    try {
      let markdown = buildYouTubeMarkdown(transcriptTitle, transcriptVideoId, transcriptLines);

      if (aiPolish) {
        setDlProgress({ current: 1, total: 3, title: 'AI 润色中...' });
        const polished = await polishSubtitlesWithChunks(markdown, transcriptLines, (c, t) => {
          setDlProgress({ current: c, total: t, title: `AI 润色 ${c}/${t}` });
        }, aiPromptStyle);
        if (!polished.success && polished.error) {
          setState('error');
          setError(`AI 润色失败：${polished.error}`);
          setDlProgress(null);
          return;
        }
        if (polished.success) markdown = polished.polished;
      }

      setDlProgress({ current: aiPolish ? 3 : 1, total: aiPolish ? 3 : 1, title: '' });
      const filename = `${transcriptTitle.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)}.md`;
      const encoded = btoa(unescape(encodeURIComponent(markdown)));
      const dataUrl = `data:text/markdown;base64,${encoded}`;
      await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
      setDlProgress(null);
      setDoneMsg(aiPolish ? '字幕已润色并下载完成' : '字幕下载完成');
      setState('done');
    } catch (err: any) {
      setState('error');
      setError(err.message || '下载失败');
      setDlProgress(null);
    }
  };

  const handleCancel = () => {
    setDlProgress(null);
    setState('idle');
  };

  const handleDownload = () => {
    const toDownload = videos.filter((v) => selected.has(v.id));
    if (toDownload.length === 0) { setError(t('youtube.selectAtLeastOne')); setState('error'); return; }

    setState('downloading');
    setError('');
    setDoneMsg('');
    setDlProgress({ current: 0, total: toDownload.length });
    setDlPhase('downloading');

    const port = chrome.runtime.connect({ name: 'youtube-download' });
    port.postMessage({
      type: exportMode === 'merged' ? 'YOUTUBE_DOWNLOAD_MERGED' : 'YOUTUBE_DOWNLOAD_SEPARATE',
      videos: toDownload,
      source: source,
      aiPolish,
      promptStyle: aiPromptStyle,
    });

    port.onMessage.addListener((msg) => {
      if (msg.phase === 'downloading') {
        setDlPhase('downloading');
        setDlProgress({ current: Number(msg.current), total: Number(msg.total), title: String(msg.title || '') });
      } else if (msg.phase === 'polishing') {
        setDlPhase('polishing');
        const cur = Number(msg.current || 0);
        const tot = Number(msg.total || 0);
        setDlProgress({ current: cur, total: tot, title: `AI 润色 ${cur}/${tot}` });
      } else if (msg.phase === 'done') {
        setDlProgress(null);
        setDlPhase('');
        port.disconnect();
        if (msg.downloaded !== undefined) {
          const { downloaded, skipped } = msg as any;
          setDoneMsg(skipped > 0
            ? `已下载 ${downloaded} 个字幕文件，${skipped} 个无字幕`
            : `已下载 ${downloaded} 个字幕文件`
          );
          setResults({ success: downloaded, failed: skipped });
        } else {
          setDoneMsg('已合并下载完成');
          setResults({ success: toDownload.length, failed: 0 });
        }
        setState('done');
      } else if (msg.phase === 'error') {
        setDlProgress(null);
        setDlPhase('');
        port.disconnect();
        setState('error');
        setError(String(msg.error || t('youtube.fetchFailed')));
      }
    });

    port.onDisconnect.addListener(() => {
      if (state === 'downloading') {
        setDlProgress(null);
        setDlPhase('');
        setState('done');
      }
    });
  };

  const toggleVideo = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(displayedVideos.map((v) => v.id)));
  const selectNone = () => setSelected(new Set());

  // Auto-fetch when opened from a YouTube tab
  const lastAutoUrl = useRef<string | null>(null);
  useEffect(() => {
    if (initialUrl && isYouTubeUrl(initialUrl) && lastAutoUrl.current !== initialUrl) {
      lastAutoUrl.current = initialUrl;
      setUrl(initialUrl);
      handleFetch();
    }
  }, [initialUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (fetchTrigger && fetchTrigger > 0 && initialUrl && isYouTubeUrl(initialUrl)) {
      lastAutoUrl.current = null;
      setUrl(initialUrl);
      handleFetch();
    }
  }, [fetchTrigger]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-fetch transcript for single video
  useEffect(() => {
    if (isSingleVideo && state === 'loaded' && videos.length === 1 && transcriptState === 'idle') {
      handleFetchTranscript();
    }
  }, [isSingleVideo, state, videos.length, transcriptState]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    getSettings().then((s) => {
      if (s.ai.promptStyle) setAiPromptStyle(s.ai.promptStyle);
    });
  }, []);

  const transcriptPreview = useMemo(() => {
    if (transcriptLines.length === 0) return '';
    return transcriptLines.slice(0, 10).map(l => l.content).join(' ');
  }, [transcriptLines]);

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
              onKeyDown={(e) => { if (e.key === 'Enter' && !isLocked) handleFetch(); }}
              readOnly={isLocked}
              placeholder={t('youtube.placeholder')}
              className="w-full pl-10 pr-3 py-2 border border-gray-200/60 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-red-500/40 focus:border-transparent placeholder:text-gray-400/70"
            />
          </div>
          <button
            onClick={handleFetch}
            disabled={!url || state === 'loading' || isLocked}
            className="px-4 py-1.5 bg-red-500 hover:bg-red-600 text-white text-xs rounded-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1 shadow-btn hover:shadow-btn-hover transition-all duration-150 btn-press"
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
                  {source.type !== 'video' && (
                    <><span className="font-mono tabular-nums">{displayedVideos.length}</span> {t('youtube.videos')}</>
                  )}
                  {source.type === 'video' && (
                    <span>{t('youtube.singleVideo')}</span>
                  )}
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
                <><ChevronDown className="w-3 h-3" />{t('youtube.loadMore')}</>
              )}
            </button>
          )}
        </div>
      )}

      {/* Single Video: Transcript Section */}
      {isSingleVideo && videos.length === 1 && state === 'loaded' && (
        <div className="space-y-3 border border-gray-200/60 rounded-lg p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700 flex items-center gap-1.5">
              <PlayCircle className="w-4 h-4 text-red-500" />
              {t('youtube.downloadSubtitles')}
            </span>
            {transcriptState === 'idle' && (
              <button
                onClick={handleFetchTranscript}
                className="px-3 py-1 text-xs bg-red-500 hover:bg-red-600 text-white rounded-lg transition-colors duration-150"
              >
                {t('youtube.fetchTranscript')}
              </button>
            )}
            {transcriptState === 'loading' && (
              <span className="flex items-center gap-1 text-xs text-red-500">
                <Loader2 className="w-3 h-3 animate-spin" />
                {t('youtube.fetchingTranscript')}
              </span>
            )}
          </div>

          {/* Transcript loading indicator for initial auto-fetch */}
          {transcriptState === 'loading' && (
            <div className="flex items-center justify-center py-3 text-gray-400">
              <Loader2 className="w-5 h-5 animate-spin mr-2" />
              <span className="text-sm">{t('youtube.fetchingTranscript')}</span>
            </div>
          )}

          {/* Transcript loaded */}
          {transcriptState === 'loaded' && (
            <>
              {/* Transcript preview */}
              <div className="bg-gray-50 rounded-lg p-3 max-h-32 overflow-y-auto">
                <p className="text-xs text-gray-600 leading-relaxed whitespace-pre-wrap">
                  {transcriptPreview}
                  {transcriptLines.length > 10 && (
                    <span className="text-gray-400 ml-1">...（共 {transcriptLines.length} 行）</span>
                  )}
                </p>
              </div>

              {/* AI Polish toggle + Download */}
              <div className="flex items-center gap-2">
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
                <div className="flex-1" />
                <button
                  onClick={handleDownloadTranscript}
                  disabled={isLocked}
                  className="px-4 py-1.5 bg-red-500 hover:bg-red-600 text-white text-xs rounded-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 shadow-btn hover:shadow-btn-hover transition-all duration-150 btn-press"
                >
                  {aiPolish ? (
                    <><Download className="w-3.5 h-3.5" />下载总结字幕</>
                  ) : (
                    <><Download className="w-3.5 h-3.5" />{t('youtube.downloadSubtitles')}</>
                  )}
                </button>
              </div>

              {aiPolish && transcriptState === 'done' && (
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
            </>
          )}

          {/* Transcript error */}
          {transcriptState === 'error' && (
            <div className="flex items-center gap-2 text-amber-500 text-xs bg-amber-50 border border-amber-100/60 rounded-lg p-2">
              <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
              {transcriptError}
            </div>
          )}
        </div>
      )}

      {/* Download Section (playlist/channel only) */}
      {displayedVideos.length > 1 && (
        <div className="space-y-3">
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
            disabled={selected.size === 0 || isLocked}
            className="w-full py-2.5 bg-red-500 hover:bg-red-600 text-white text-sm rounded-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-btn hover:shadow-btn-hover transition-all duration-150 btn-press"
          >
            {state === 'downloading' ? (
              <><Loader2 className="w-4 h-4 animate-spin" />{dlPhase === 'polishing' ? 'AI 润色中...' : t('youtube.downloadingProgress')}</>
            ) : state === 'done' ? (
              <><CheckCircle className="w-4 h-4" />{t('youtube.downloadDone')}</>
            ) : (
              <><Download className="w-4 h-4" />{t('youtube.downloadSubtitles')}（{selected.size}）</>
            )}
          </button>
        </div>
      )}

      {/* Download Progress Overlay */}
      {isLocked && dlProgress && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-xl border border-gray-100 p-6 w-[280px] text-center space-y-4 animate-fade-in">
            <div className="w-12 h-12 mx-auto rounded-full bg-red-500/10 flex items-center justify-center">
              <Download className="w-6 h-6 text-red-500" />
            </div>
            <div>
              <p className="text-sm font-medium text-gray-800">{t('youtube.downloading')}</p>
              {dlProgress.title && (
                <p className="text-xs text-gray-400 mt-1">{dlProgress.title}</p>
              )}
            </div>
            {dlProgress.total > 1 && (
              <div className="w-full bg-gray-100 rounded-full h-1.5 overflow-hidden">
                <div
                  className="bg-red-500 h-1.5 rounded-full transition-all duration-500"
                  style={{ width: `${Math.round((dlProgress.current / dlProgress.total) * 100)}%` }}
                />
              </div>
            )}
            <div className="flex items-center justify-center gap-1 text-red-500">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span className="text-xs text-gray-400">处理中…</span>
            </div>
            <button
              onClick={handleCancel}
              className="w-full py-2 text-xs font-medium text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg border border-gray-200 transition-colors duration-150 flex items-center justify-center gap-1"
            >
              <X className="w-3 h-3" />
              {t('youtube.cancel')}
            </button>
          </div>
        </div>
      )}

      {/* Results */}
      {results && state === 'done' && !isSingleVideo && (
        <div className="text-sm text-center">
          {results.failed === 0 ? (
            <span className="text-green-600">{t('successCount', { success: results.success })}</span>
          ) : (
            <span className="text-amber-600">{t('successFailCount', { success: results.success, failed: results.failed })}</span>
          )}
        </div>
      )}

      {/* Done message for single video transcript */}
      {state === 'done' && isSingleVideo && doneMsg && (
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
