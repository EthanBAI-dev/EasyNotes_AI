import { useState, useEffect } from 'react';
import {
  Bookmark,
  BookmarkPlus,
  Loader2,
  CheckCircle,
  AlertCircle,
  Trash2,
  Copy,
  FolderPlus,
  X,
  Download,
  Eye,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import type { ImportProgress } from '@/lib/types';
import type { BookmarkItem } from '@/services/bookmarks';
import { t } from '@/lib/i18n';
import { PROMPT_STYLES } from '@/services/ai-polish';
import { setOpState, clearOpState, getOpState } from '@/services/op-state';

interface Props {
  onProgress: (progress: ImportProgress | null) => void;
}

type PanelState = 'idle' | 'loading' | 'summarizing' | 'downloading' | 'success' | 'error';

const OUTPUT_FORMATS = [
  { value: 'md', label: '.md' },
  { value: 'txt', label: '.txt' },
] as const;

type OutputFormat = typeof OUTPUT_FORMATS[number]['value'];

export function BookmarkPanel({ onProgress }: Props) {
  const [bookmarks, setBookmarks] = useState<BookmarkItem[]>([]);
  const [collections, setCollections] = useState<string[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [activeCollection, setActiveCollection] = useState<string>('all');
  const [state, setState] = useState<PanelState>('idle');
  const [error, setError] = useState('');
  const [currentTabInfo, setCurrentTabInfo] = useState<{ url: string; title: string; favicon?: string } | null>(null);
  const [isCurrentBookmarked, setIsCurrentBookmarked] = useState(false);
  const [showNewCollection, setShowNewCollection] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState('');
  const [aiSummary, setAiSummary] = useState(true);
  const [exportMode, setExportMode] = useState<'separate' | 'merged'>('merged');
  const [outputFormat, setOutputFormat] = useState<OutputFormat>('md');
  const [aiPromptStyle, setAiPromptStyle] = useState('summary');
  const [summaryContent, setSummaryContent] = useState('');
  const [showPreview, setShowPreview] = useState(false);
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const [copiedPreview, setCopiedPreview] = useState(false);

  useEffect(() => {
    loadData();
    loadCurrentTab();
  }, []);

  const loadData = () => {
    chrome.runtime.sendMessage({ type: 'GET_BOOKMARKS' }, (resp) => {
      if (resp?.success) setBookmarks(resp.data || []);
    });
    chrome.runtime.sendMessage({ type: 'GET_COLLECTIONS' }, (resp) => {
      if (resp?.success) setCollections(resp.data || []);
    });
  };

  const loadCurrentTab = () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (tab?.url?.startsWith('http')) {
        setCurrentTabInfo({
          url: tab.url,
          title: tab.title || tab.url,
          favicon: tab.favIconUrl,
        });
        chrome.runtime.sendMessage({ type: 'IS_BOOKMARKED', url: tab.url }, (resp) => {
          if (resp?.success) setIsCurrentBookmarked(resp.data);
        });
      }
    });
  };

  const handleAddBookmark = (collection?: string) => {
    if (!currentTabInfo) return;
    chrome.runtime.sendMessage(
      { type: 'ADD_BOOKMARK', url: currentTabInfo.url, title: currentTabInfo.title, favicon: currentTabInfo.favicon, collection },
      (resp) => {
        if (resp?.success) {
          setIsCurrentBookmarked(true);
          loadData();
        }
      }
    );
  };

  const handleRemove = (id: string) => {
    chrome.runtime.sendMessage({ type: 'REMOVE_BOOKMARK', id }, () => {
      setSelectedIds((prev) => { const n = new Set(prev); n.delete(id); return n; });
      loadData();
      if (currentTabInfo) {
        chrome.runtime.sendMessage({ type: 'IS_BOOKMARKED', url: currentTabInfo.url }, (resp) => {
          if (resp?.success) setIsCurrentBookmarked(resp.data);
        });
      }
    });
  };

  const handleRemoveSelected = () => {
    if (selectedIds.size === 0) return;
    chrome.runtime.sendMessage({ type: 'REMOVE_BOOKMARKS', ids: Array.from(selectedIds) }, () => {
      setSelectedIds(new Set());
      loadData();
    });
  };

  const handleCreateCollection = () => {
    if (!newCollectionName.trim()) return;
    chrome.runtime.sendMessage({ type: 'CREATE_COLLECTION', name: newCollectionName.trim() }, () => {
      setNewCollectionName('');
      setShowNewCollection(false);
      loadData();
    });
  };

  const handleDeleteCollection = (name: string) => {
    if (name === '默认收藏') return;
    chrome.runtime.sendMessage({ type: 'DELETE_COLLECTION', name }, () => {
      if (activeCollection === name) setActiveCollection('all');
      deselectAll();
      loadData();
    });
  };

  const fetchPageContent = (url: string): Promise<string> => {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'FETCH_PAGE_CONTENT', url }, (resp) => {
        if (resp?.success) {
          const data = resp.data as { markdown: string; title: string };
          resolve(data.markdown || '');
        } else {
          reject(new Error(resp?.error || '抓取页面内容失败'));
        }
      });
    });
  };

  const handleGenerateSummary = async () => {
    const items = filteredBookmarks.filter((b) => selectedIds.has(b.id));
    if (items.length === 0) return;

    setState('summarizing');
    setError('');
    setSummaryContent('');
    setShowPreview(false);

    await setOpState({
      active: true,
      phase: 'downloading',
      kind: 'export',
      current: 0,
      total: items.length,
      title: items[0]?.title || '',
      timestamp: Date.now(),
    });

    try {
      const pageContents: { title: string; url: string; content: string }[] = [];

      for (let i = 0; i < items.length; i++) {
        const stillActive = await getOpState();
        if (!stillActive) {
          setState('idle');
          return;
        }
        try {
          const content = await fetchPageContent(items[i].url);
          if (content) {
            pageContents.push({ title: items[i].title, url: items[i].url, content });
          }
        } catch {
          // Individual page fetch failure is non-fatal
        }
        setOpState({
          active: true,
          phase: 'downloading',
          kind: 'export',
          current: i + 1,
          total: items.length,
          title: items[i].title,
          timestamp: Date.now(),
        });
      }

      if (pageContents.length === 0) {
        setState('error');
        setError('所有页面内容抓取失败');
        return;
      }

      let combinedText: string;
      if (exportMode === 'merged' || pageContents.length === 1) {
        const sections = pageContents.map((p) => `## ${p.title}\n\n> ${p.url}\n\n${p.content}`);
        combinedText = sections.join('\n\n---\n\n');
      } else {
        combinedText = pageContents.map((p) => `# ${p.title}\n\n> ${p.url}\n\n${p.content}`).join('\n\n');
      }

      if (aiSummary) {
        const { polishSubtitlesWithChunks } = await import('@/services/ai-polish');
        const result = await polishSubtitlesWithChunks(combinedText, undefined, undefined, aiPromptStyle);

        if (result.success) {
          setSummaryContent(result.polished);
        } else {
          setState('error');
          setError(result.error || 'AI 总结失败');
          clearOpState();
          return;
        }
      } else {
        setSummaryContent(combinedText);
      }

      setState('idle');
      setShowPreview(true);
      clearOpState();
    } catch (err) {
      setState('error');
      setError(err instanceof Error ? err.message : 'AI 总结处理失败');
      clearOpState();
    }
  };

  const handleDownloadSummary = () => {
    if (!summaryContent) return;

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const collectionName = activeCollection === 'all' ? 'web_summary' : activeCollection.replace(/[\\/:*?"<>|]/g, '_');
    const ext = outputFormat === 'txt' ? 'txt' : 'md';
    const filename = `${collectionName}_${timestamp}.${ext}`;

    let downloadContent = summaryContent;
    if (outputFormat === 'txt') {
      downloadContent = summaryContent
        .replace(/#{1,6}\s+/g, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/^>\s?/gm, '');
    }

    const mimeType = outputFormat === 'txt' ? 'text/plain' : 'text/markdown';
    const encoded = btoa(unescape(encodeURIComponent(downloadContent)));
    const dataUrl = `data:${mimeType};base64,${encoded}`;
    chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
    setState('success');
    setTimeout(() => setState('idle'), 3000);
  };

  const handleCopySummary = async () => {
    if (!summaryContent) return;
    try {
      await navigator.clipboard.writeText(summaryContent);
      setCopiedPreview(true);
      setTimeout(() => setCopiedPreview(false), 2000);
    } catch {
      setError('复制失败');
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const filteredBookmarks = activeCollection === 'all'
    ? bookmarks
    : bookmarks.filter((b) => b.collection === activeCollection);

  const selectAll = () => setSelectedIds(new Set(filteredBookmarks.map((b) => b.id)));
  const deselectAll = () => setSelectedIds(new Set());

  const handleMoveSelected = (targetCollection: string) => {
    if (selectedIds.size === 0) return;
    chrome.runtime.sendMessage(
      { type: 'MOVE_BOOKMARKS', ids: Array.from(selectedIds), collection: targetCollection },
      () => {
        setSelectedIds(new Set());
        loadData();
      }
    );
  };

  const handleMoveItem = (id: string, targetCollection: string) => {
    chrome.runtime.sendMessage(
      { type: 'MOVE_BOOKMARK', id, collection: targetCollection },
      () => loadData()
    );
  };

  return (
    <div className="space-y-3">
      {/* Add current page */}
      {currentTabInfo && (
        <div className="bg-surface-sunken rounded-xl p-3 shadow-soft">
          <div className="flex items-center gap-2">
            {currentTabInfo.favicon && (
              <img src={currentTabInfo.favicon} className="w-4 h-4 flex-shrink-0" alt="" />
            )}
            <span className="flex-1 text-sm text-gray-700 truncate">{currentTabInfo.title}</span>
            {isCurrentBookmarked ? (
              <span className="flex items-center gap-1 text-xs text-brand-600 bg-blue-50/80 px-2 py-1 rounded-md border border-blue-200/40">
                <Bookmark className="w-3 h-3 fill-current" />
                {t('bookmark.bookmarked')}
              </span>
            ) : (
              <button
                onClick={() => handleAddBookmark()}
                className="btn-press flex items-center gap-1 px-3 py-1.5 bg-brand-600 text-white text-xs rounded-md hover:bg-brand-dark transition-colors shadow-btn hover:shadow-btn-hover transition-all duration-150"
              >
                <BookmarkPlus className="w-3 h-3" />
                {t('bookmark.addBookmark')}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Collection tabs — "all" is always visible */}
      <div className="flex items-center gap-1 overflow-x-auto flex-wrap">
        <button
          onClick={() => { setActiveCollection('all'); deselectAll(); }}
          className={`btn-press px-2.5 py-1 text-xs rounded-full whitespace-nowrap transition-colors ${
            activeCollection === 'all' ? 'bg-brand-600 text-white shadow-sm' : 'bg-gray-100/60 text-gray-600 hover:bg-gray-200'
          }`}
        >
          {t('bookmark.all')} ({bookmarks.length})
        </button>
        {collections.map((col) => {
          const count = bookmarks.filter((b) => b.collection === col).length;
          return (
            <div key={col} className="flex items-center">
              <button
                onClick={() => { setActiveCollection(col); deselectAll(); }}
                className={`btn-press px-2.5 py-1 text-xs rounded-full whitespace-nowrap transition-colors ${
                  activeCollection === col ? 'bg-brand-600 text-white shadow-sm' : 'bg-gray-100/60 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {col} ({count})
              </button>
              {col !== '默认收藏' && (
                <button
                  onClick={(e) => { e.stopPropagation(); handleDeleteCollection(col); }}
                  className="btn-press ml-0.5 p-0.5 text-gray-300 hover:text-red-500 rounded-full"
                  title="删除分组"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          );
        })}
        <button
          onClick={() => setShowNewCollection(!showNewCollection)}
          className="btn-press p-1 text-gray-400 hover:text-gray-600 rounded"
          title={t('bookmark.newCollection')}
        >
          <FolderPlus className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* New collection input */}
      {showNewCollection && (
        <div className="flex gap-2">
          <input
            type="text"
            value={newCollectionName}
            onChange={(e) => setNewCollectionName(e.target.value)}
            placeholder={t('bookmark.collectionName')}
            className="flex-1 px-3 py-1.5 border border-gray-200/60 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            onKeyDown={(e) => { if (e.key === 'Enter') handleCreateCollection(); }}
          />
          <button onClick={handleCreateCollection} className="btn-press px-3 py-1.5 bg-brand-600 text-white text-xs rounded-lg hover:bg-brand-dark">
            {t('create')}
          </button>
          <button onClick={() => setShowNewCollection(false)} className="btn-press p-1.5 text-gray-400 hover:text-gray-600">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Bookmark list */}
      {filteredBookmarks.length > 0 ? (
        <>
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-500 font-mono tabular-nums">
              {selectedIds.size > 0 ? t('bookmark.selectedItems', { count: selectedIds.size }) : t('bookmark.totalItems', { count: filteredBookmarks.length })}
            </span>
            <div className="flex gap-2 text-xs">
              <button onClick={selectAll} className="btn-press text-brand-600 hover:underline">{t('selectAll')}</button>
              <button onClick={deselectAll} className="btn-press text-gray-400 hover:underline">{t('cancel')}</button>
              {selectedIds.size > 0 && (
                <>
                  {collections.length > 0 && (
                    <select
                      onChange={(e) => { if (e.target.value) { handleMoveSelected(e.target.value); e.target.value = ''; } }}
                      className="text-xs text-gray-500 bg-transparent border border-gray-200 rounded px-1 py-0.5 cursor-pointer hover:border-gray-300"
                      defaultValue=""
                    >
                      <option value="" disabled>{t('bookmark.moveTo')}</option>
                      {collections.filter((c) => c !== activeCollection || activeCollection === 'all').map((col) => (
                        <option key={col} value={col}>{col}</option>
                      ))}
                    </select>
                  )}
                  <button onClick={handleRemoveSelected} className="btn-press text-red-400 hover:text-red-600">{t('delete')}</button>
                </>
              )}
            </div>
          </div>

          <div className="max-h-[200px] overflow-y-auto border border-border-strong rounded-lg shadow-soft">
            {filteredBookmarks.map((item) => (
              <label
                key={item.id}
                className="flex items-center gap-2 p-2 hover:bg-gray-50 cursor-pointer border-b border-gray-100/60 last:border-b-0 transition-colors"
              >
                <input
                  type="checkbox"
                  checked={selectedIds.has(item.id)}
                  onChange={() => toggleSelect(item.id)}
                  className="rounded border-gray-300 text-brand-600 focus:ring-blue-500"
                />
                {item.favicon && <img src={item.favicon} className="w-4 h-4 flex-shrink-0" alt="" />}
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-gray-700 truncate">{item.title}</p>
                  <p className="text-[10px] text-gray-400 truncate">{item.url}</p>
                </div>
                {collections.length > 1 && (
                  <select
                    value=""
                    onChange={(e) => { e.preventDefault(); e.stopPropagation(); if (e.target.value) { handleMoveItem(item.id, e.target.value); e.target.value = ''; } }}
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
                    className="text-[10px] text-gray-400 bg-transparent border border-gray-200/60 rounded px-1 py-0.5 cursor-pointer hover:border-gray-300 flex-shrink-0 max-w-[60px]"
                  >
                    <option value="" disabled>{t('bookmark.moveToCollection')}</option>
                    {collections.filter((c) => c !== item.collection).map((col) => (
                      <option key={col} value={col}>{col}</option>
                    ))}
                  </select>
                )}
                <button
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleRemove(item.id); }}
                  className="btn-press p-1 text-gray-300 hover:text-red-500 flex-shrink-0"
                  title={t('delete')}
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </label>
            ))}
          </div>

          {/* Output Mode — single unified section */}
          {selectedIds.size > 0 && (
            <div className="space-y-3">
              <label className="block text-sm font-medium text-gray-700 flex items-center gap-1.5">
                <Download className="w-4 h-4 text-brand-600" />
                {t('youtube.outputMode')}
              </label>
              <div className="flex items-center gap-1.5">
                {selectedIds.size > 1 && (
                  <div className="flex rounded-lg border border-gray-200/60 overflow-hidden">
                    <button
                      onClick={() => setExportMode('separate')}
                      className={`px-2.5 py-1 text-[11px] font-medium transition-colors duration-150 ${
                        exportMode === 'separate'
                          ? 'bg-brand-600 text-white'
                          : 'bg-white text-gray-400 hover:text-gray-500'
                      }`}
                    >
                      Split
                    </button>
                    <button
                      onClick={() => setExportMode('merged')}
                      className={`px-2.5 py-1 text-[11px] font-medium transition-colors duration-150 border-l border-gray-200/60 ${
                        exportMode === 'merged'
                          ? 'bg-brand-600 text-white'
                          : 'bg-white text-gray-400 hover:text-gray-500'
                      }`}
                    >
                      Merged
                    </button>
                  </div>
                )}
                <select
                  value={outputFormat}
                  onChange={(e) => setOutputFormat(e.target.value as OutputFormat)}
                  className="text-[11px] border border-gray-200/60 rounded-lg px-2 py-1 bg-white text-gray-600 focus:outline-none focus:ring-1 focus:ring-brand-600/40"
                >
                  {OUTPUT_FORMATS.map((f) => (
                    <option key={f.value} value={f.value}>{f.label}</option>
                  ))}
                </select>
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

              <button
                onClick={handleGenerateSummary}
                disabled={state === 'summarizing'}
                className={`btn-press w-full py-2.5 text-white text-sm rounded-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-btn hover:shadow-btn-hover transition-all duration-150 ${state === 'summarizing' ? 'bg-brand-600/70' : 'bg-brand-600 hover:bg-brand-600/90'}`}
              >
                {state === 'summarizing' ? (
                  <><Loader2 className="w-4 h-4 animate-spin" />AI 总结生成中…</>
                ) : (
                  <><Download className="w-4 h-4" />{aiSummary ? '生成 AI 总结' : '获取页面内容'}（{selectedIds.size}）</>
                )}
              </button>
            </div>
          )}

          {/* Summary Preview */}
          {showPreview && summaryContent && (
            <div className="space-y-2 bg-surface-sunken rounded-xl border border-gray-200/60 overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100/60 bg-white/60">
                <div className="flex items-center gap-2">
                  <Eye className="w-3.5 h-3.5 text-brand-600" />
                  <span className="text-xs font-medium text-gray-700">AI 总结预览</span>
                </div>
                <div className="flex items-center gap-0.5">
                  <button
                    onClick={handleCopySummary}
                    className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-colors"
                    title="复制内容"
                  >
                    {copiedPreview ? (
                      <CheckCircle className="w-3.5 h-3.5 text-green-500" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                  </button>
                  <button
                    onClick={() => setPreviewExpanded(!previewExpanded)}
                    className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-colors"
                    title={previewExpanded ? '收起' : '展开'}
                  >
                    {previewExpanded ? (
                      <Minimize2 className="w-3.5 h-3.5" />
                    ) : (
                      <Maximize2 className="w-3.5 h-3.5" />
                    )}
                  </button>
                  <button
                    onClick={() => { setShowPreview(false); setSummaryContent(''); }}
                    className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors"
                    title="关闭预览"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              <div
                className={`overflow-y-auto px-3 py-2 ${
                  previewExpanded ? 'max-h-[400px]' : 'max-h-[180px]'
                } transition-all duration-200`}
              >
                <pre className="text-xs text-gray-700 whitespace-pre-wrap font-sans leading-relaxed">
                  {summaryContent}
                </pre>
              </div>
              <div className="flex gap-1.5 px-3 py-2 border-t border-gray-100/60 bg-white/60">
                <button
                  onClick={() => setOutputFormat('md')}
                  className={`px-3 py-1 text-[11px] rounded-full border transition-colors duration-150 ${
                    outputFormat === 'md'
                      ? 'bg-brand-600 text-white border-brand-600'
                      : 'bg-white text-gray-500 border-gray-200 hover:border-brand-300 hover:text-brand-600'
                  }`}
                >
                  .md
                </button>
                <button
                  onClick={() => setOutputFormat('txt')}
                  className={`px-3 py-1 text-[11px] rounded-full border transition-colors duration-150 ${
                    outputFormat === 'txt'
                      ? 'bg-brand-600 text-white border-brand-600'
                      : 'bg-white text-gray-500 border-gray-200 hover:border-brand-300 hover:text-brand-600'
                  }`}
                >
                  .txt
                </button>
                <div className="flex-1" />
                <button
                  onClick={handleDownloadSummary}
                  className="btn-press px-4 py-1 bg-brand-600 text-white text-xs rounded-lg hover:bg-brand-600/90 flex items-center gap-1.5 shadow-btn hover:shadow-btn-hover transition-all duration-150"
                >
                  <Download className="w-3 h-3" />
                  下载 {outputFormat === 'txt' ? '.txt' : '.md'}
                </button>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="flex flex-col items-center py-6 bg-surface-sunken rounded-xl px-5">
          <Bookmark className="w-8 h-8 text-blue-400/60 mb-2" />
          <p className="text-sm text-gray-600 font-medium">{t('bookmark.emptyTitle')}</p>
          <p className="text-xs text-gray-400 mt-1.5 mb-3 text-center leading-relaxed max-w-[280px]">
            {t('bookmark.emptyDesc')}
          </p>
          <div className="w-full space-y-2 text-[11px] text-gray-500 bg-white/60 rounded-lg p-3 border border-gray-100/80">
            <div className="flex items-start gap-2">
              <span className="flex-shrink-0 w-5 h-5 rounded-full bg-blue-100 text-brand-600 flex items-center justify-center text-[10px] font-bold">1</span>
              <span>{t('bookmark.step1')}</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="flex-shrink-0 w-5 h-5 rounded-full bg-blue-100 text-brand-600 flex items-center justify-center text-[10px] font-bold">2</span>
              <span>{t('bookmark.step2')}</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="flex-shrink-0 w-5 h-5 rounded-full bg-blue-100 text-brand-600 flex items-center justify-center text-[10px] font-bold">3</span>
              <span>{t('bookmark.step3')}</span>
            </div>
          </div>
        </div>
      )}

      {/* Status messages */}
      {state === 'success' && (
        <div className="flex items-center gap-2 text-green-600 text-sm bg-green-50 rounded-lg p-3 shadow-soft border border-green-100">
          <CheckCircle className="w-4 h-4" />{t('downloadSuccess')}
        </div>
      )}
      {state === 'error' && (
        <div className="flex items-center gap-2 text-red-500 text-sm bg-red-50 rounded-lg p-3 shadow-soft border border-red-100">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />{error}
        </div>
      )}

    </div>
  );
}
