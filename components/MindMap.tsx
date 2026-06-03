import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, Download, ZoomIn, ZoomOut, Maximize, Minimize, Maximize2, X, Brain, FileText, Code2 } from 'lucide-react';
import { t } from '@/lib/i18n';
import { getSettings } from '@/lib/settings';
import { PROVIDER_ENDPOINTS, DEFAULT_MODELS } from '@/services/ai-polish';

interface MindNode {
  text: string;
  lines: string[];
  children: MindNode[];
  x: number;
  y: number;
  width: number;
  height: number;
}

const NODE_PADDING_X = 14;
const NODE_PADDING_Y = 8;
const FONT_SIZE = 12;
const LEVEL_GAP = 50;
const NODE_GAP = 16;
const MAX_NODE_WIDTH = 200;
const BRANCH_COLORS = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#F4A460', '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9'];

function estimateTextWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) {
      w += FONT_SIZE;
    } else if (/[A-Z]/.test(ch)) {
      w += FONT_SIZE * 0.72;
    } else if (/[a-z0-9]/.test(ch)) {
      w += FONT_SIZE * 0.58;
    } else if (ch === ' ') {
      w += FONT_SIZE * 0.3;
    } else {
      w += FONT_SIZE * 0.6;
    }
  }
  return w;
}

function wrapText(text: string, maxWidth: number): string[] {
  if (estimateTextWidth(text) <= maxWidth) return [text];
  const lines: string[] = [];
  let current = '';
  for (const ch of text) {
    if (estimateTextWidth(current + ch) > maxWidth - 4) {
      if (current) lines.push(current);
      current = ch;
    } else {
      current += ch;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [text];
}

function parseMarkdownToTree(md: string): MindNode | null {
  const lines = md.split('\n').filter(l => l.trim());
  if (lines.length === 0) return null;

  const makeNode = (text: string): MindNode => {
    const wrapped = wrapText(text, MAX_NODE_WIDTH);
    const maxLineW = Math.max(...wrapped.map(estimateTextWidth));
    return {
      text,
      lines: wrapped,
      children: [],
      x: 0, y: 0,
      width: Math.min(maxLineW + NODE_PADDING_X * 2, MAX_NODE_WIDTH + NODE_PADDING_X * 2),
      height: wrapped.length * (FONT_SIZE + 5) + NODE_PADDING_Y * 2,
    };
  };

  const root = makeNode('思维导图');
  root.width = 0;
  let currentNode: MindNode | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('## ')) {
      const node = makeNode(trimmed.slice(3).trim());
      root.children.push(node);
      currentNode = node;
    } else if (trimmed.startsWith('- ') && currentNode) {
      currentNode.children.push(makeNode(trimmed.slice(2).trim()));
    }
  }

  if (root.children.length === 0 && lines.length > 0) {
    const firstLine = lines[0].trim();
    const t = firstLine.startsWith('# ') ? firstLine.slice(2) : firstLine.replace(/^[#\-\s]+/, '');
    const nr = makeNode(t);
    root.text = t;
    root.lines = nr.lines;
    root.width = nr.width;
    root.height = nr.height;
    let cur: MindNode | null = null;
    for (let i = 1; i < lines.length; i++) {
      const l = lines[i].trim();
      if (l.startsWith('## ')) {
        const n = makeNode(l.slice(3).trim());
        root.children.push(n);
        cur = n;
      } else if (l.startsWith('- ') && cur) {
        cur.children.push(makeNode(l.slice(2).trim()));
      } else if (l.startsWith('- ') && !cur) {
        root.children.push(makeNode(l.slice(2).trim()));
      }
    }
  }

  return root;
}

function layoutTree(node: MindNode, x: number, y: number): number {
  node.x = x;
  if (node.children.length === 0) {
    node.y = y;
    return node.height + NODE_GAP;
  }
  const childXs = x + node.width + LEVEL_GAP;
  let totalH = 0;
  for (const child of node.children) {
    totalH += layoutTree(child, childXs, y + totalH);
  }
  const firstChild = node.children[0];
  const lastChild = node.children[node.children.length - 1];
  const childrenCenter = firstChild.y + (lastChild.y + lastChild.height - firstChild.y) / 2;
  node.y = childrenCenter - node.height / 2;
  return Math.max(totalH, node.height);
}

function renderSvg(node: MindNode, depth: number, colorIdx: number): JSX.Element[] {
  const color = BRANCH_COLORS[colorIdx % BRANCH_COLORS.length];
  const els: JSX.Element[] = [];
  const rx = 8;

  els.push(
    <g key={`node-${node.text.slice(0, 12)}-${depth}`}>
      <rect
        x={node.x}
        y={node.y}
        width={node.width}
        height={node.height}
        rx={rx}
        ry={rx}
        fill={depth === 0 ? color : '#ffffff'}
        stroke={color}
        strokeWidth={depth === 0 ? 0 : 1.5}
        filter={depth === 0 ? 'url(#mindmapShadow)' : undefined}
      />
      {node.lines.map((line, li) => (
        <text
          key={li}
          x={node.x + node.width / 2}
          y={node.y + NODE_PADDING_Y + FONT_SIZE + li * (FONT_SIZE + 5)}
          textAnchor="middle"
          dominantBaseline="alphabetic"
          fill={depth === 0 ? '#ffffff' : '#333333'}
          fontSize={FONT_SIZE}
          fontWeight={depth === 0 ? 'bold' : 'normal'}
          fontFamily="'PingFang SC', 'Microsoft YaHei', sans-serif"
        >
          {line}
        </text>
      ))}
    </g>
  );

  for (const child of node.children) {
    const sx = node.x + node.width;
    const sy = node.y + node.height / 2;
    const ex = child.x;
    const ey = child.y + child.height / 2;
    const mx = (sx + ex) / 2;
    els.push(
      <path
        key={`path-${node.text.slice(0,8)}-${child.text.slice(0,8)}`}
        d={`M${sx},${sy} C${mx},${sy} ${mx},${ey} ${ex},${ey}`}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeOpacity={0.5}
      />
    );
    els.push(...renderSvg(child, depth + 1, colorIdx + 1));
  }

  return els;
}

interface Props {
  text: string;
  onClose: () => void;
  title?: string;
  /** raw subtitle markdown for display & txt export */
  subtitleText?: string;
}

export function MindMap({ text, onClose, title, subtitleText }: Props) {
  const [scale, setScale] = useState(0.6);
  const [pan, setPan] = useState({ x: 40, y: 30 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [mode, setMode] = useState<'mindmap' | 'subtitle' | 'raw'>('mindmap');

  const rawText = subtitleText || text;
  const displaySubtitleText = subtitleText || text;

  const viewportRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const tree = useMemo(() => {
    const t = parseMarkdownToTree(text);
    if (!t) return null;
    layoutTree(t, 20, 20);
    return t;
  }, [text]);

  const svgSize = useMemo(() => {
    if (!tree) return { w: 800, h: 400 };
    let maxX = 0; let maxY = 0;
    const walk = (n: MindNode) => {
      maxX = Math.max(maxX, n.x + n.width);
      maxY = Math.max(maxY, n.y + n.height);
      n.children.forEach(walk);
    };
    walk(tree);
    return { w: maxX + 60, h: maxY + 60 };
  }, [tree]);

  // 用原生 addEventListener 绕过 Chrome 的 passive wheel 限制
  const onScaleRef = useRef<(delta: number) => void>(() => {});
  onScaleRef.current = (delta: number) => {
    setScale(s => Math.max(0.15, Math.min(4, s * (delta > 0 ? 0.92 : 1.08))));
  };

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      onScaleRef.current(e.deltaY);
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    setIsDragging(true);
    setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
  }, [pan]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging) return;
    setPan({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
  }, [isDragging, dragStart]);

  const handleMouseUp = useCallback(() => setIsDragging(false), []);

  const handleExportPng = useCallback(async () => {
    if (!svgRef.current) return;
    const svgData = new XMLSerializer().serializeToString(svgRef.current);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = new Image();
    const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);
    img.onload = () => {
      canvas.width = svgSize.w * 2;
      canvas.height = svgSize.h * 2;
      ctx.fillStyle = '#fafbfc';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob(blob => {
        if (!blob) return;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'mindmap.png';
        a.click();
      }, 'image/png');
    };
    img.src = url;
  }, [svgSize]);

  const handleExportSource = useCallback(() => {
    if (!tree) return;
    const toObj = (n: MindNode): any => ({
      text: n.text,
      children: n.children.map(toObj),
    });
    const json = JSON.stringify(toObj(tree), null, 2);
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'mindmap.json';
    a.click();
  }, [tree]);

  const handleExportTxt = useCallback(() => {
    const plain = rawText
      .replace(/^#{1,4}\s+/gm, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/^\s*[-*+]\s+/gm, '  • ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    const blob = new Blob([plain], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'subtitle.txt';
    a.click();
  }, [rawText]);

  const subtitleHtml = useMemo(() => {
    let html = displaySubtitleText
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    html = html.replace(/^### (.+)$/gm, '<h4 class="text-sm font-semibold text-gray-800 mt-3 mb-1">$1</h4>');
    html = html.replace(/^## (.+)$/gm, '<h3 class="text-base font-bold text-purple-700 mt-4 mb-2 border-b border-purple-100 pb-1">$1</h3>');
    html = html.replace(/^# (.+)$/gm, '<h2 class="text-lg font-bold text-purple-800 mt-5 mb-3">$1</h2>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong class="font-semibold text-gray-900">$1</strong>');
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    html = html.replace(/`([^`]+)`/g, '<code class="bg-purple-50 text-purple-700 px-1 rounded text-xs">$1</code>');
    html = html.replace(/^\s*[-*+]\s+(.+)$/gm, '<li class="ml-4 list-disc text-gray-700">$1</li>');
    html = html.replace(/\n{2,}/g, '</p><p class="mb-2">');
    html = '<p class="mb-2">' + html + '</p>';
    return html;
  }, [displaySubtitleText]);

  const rawPlainText = useMemo(() => {
    return rawText
      .replace(/^#{1,4}\s+/gm, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/^\s*[-*+]\s+/gm, '  • ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }, [rawText]);

  const handleZoomIn = () => setScale(s => Math.min(4, Math.round(s * 1.25 * 100) / 100));
  const handleZoomOut = () => setScale(s => Math.max(0.15, Math.round(s / 1.25 * 100) / 100));

  const handleFit = useCallback(() => {
    if (!viewportRef.current) return;
    const vw = viewportRef.current.clientWidth - 20;
    const vh = viewportRef.current.clientHeight - 20;
    const sx = vw / svgSize.w;
    const sy = vh / svgSize.h;
    const fitScale = Math.min(sx, sy, 1.2);
    setScale(Math.round(fitScale * 100) / 100);
    setPan({
      x: Math.round((vw - svgSize.w * fitScale) / 2),
      y: Math.round((vh - svgSize.h * fitScale) / 2),
    });
  }, [svgSize]);

  const handleFullscreen = useCallback(() => {
    setIsFullscreen(prev => {
      const next = !prev;
      if (next) {
        setTimeout(handleFit, 200);
      }
      return next;
    });
  }, [handleFit]);

  useEffect(() => {
    if (tree) {
      const timer = setTimeout(handleFit, 100);
      return () => clearTimeout(timer);
    }
  }, [tree]);

  if (!tree) {
    return (
      <div className="border border-purple-100/60 rounded-lg bg-white shadow-soft" ref={cardRef}>
        <div className="flex items-center justify-between px-3 py-2 bg-purple-50 border-b border-purple-100 rounded-t-lg">
          <span className="text-sm font-medium text-gray-700 flex items-center gap-1.5">
            <Brain className="w-4 h-4 text-purple-500" />
            {title || t('mindmap.title')}
          </span>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-0.5"><X className="w-4 h-4" /></button>
        </div>
        <div className="flex items-center justify-center py-10 text-gray-400">
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          <span className="text-sm">AI 正在生成思维导图…</span>
        </div>
      </div>
    );
  }

  const svgViewport = (
    <>
      {/* SVG Viewport */}
      <div
        ref={viewportRef}
        className={`overflow-hidden select-none relative group ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
        style={{ height: isFullscreen ? '100%' : '360px' }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={(e) => { handleMouseUp(); }}
        onMouseEnter={() => {}}
      >
        {/* Toolbar */}
        <div
          className="absolute top-2 right-2 flex items-center gap-1 bg-white/90 backdrop-blur border border-gray-200 rounded-lg shadow-sm p-1 z-10"
        >
          {mode === 'mindmap' ? (
            <>
              <button onClick={handleExportPng} className="p-1.5 text-gray-500 hover:text-purple-600 hover:bg-purple-50 rounded transition-colors" title={t('mindmap.exportPng')}>
                <Download className="w-3.5 h-3.5" />
              </button>
              <button onClick={handleExportSource} className="p-1.5 text-gray-500 hover:text-purple-600 hover:bg-purple-50 rounded transition-colors" title={t('mindmap.exportSource')}>
                <Code2 className="w-3.5 h-3.5" />
              </button>
              <div className="w-px h-4 bg-gray-200" />
              <button onClick={handleZoomIn} className="p-1.5 text-gray-500 hover:text-purple-600 hover:bg-purple-50 rounded transition-colors" title={t('mindmap.zoomIn')}>
                <ZoomIn className="w-3.5 h-3.5" />
              </button>
              <button onClick={handleZoomOut} className="p-1.5 text-gray-500 hover:text-purple-600 hover:bg-purple-50 rounded transition-colors" title={t('mindmap.zoomOut')}>
                <ZoomOut className="w-3.5 h-3.5" />
              </button>
              <button onClick={handleFit} className="p-1.5 text-gray-500 hover:text-purple-600 hover:bg-purple-50 rounded transition-colors" title={t('mindmap.fit')}>
                <Maximize className="w-3.5 h-3.5" />
              </button>
              <div className="w-px h-4 bg-gray-200" />
            </>
          ) : (
            <button onClick={handleExportTxt} className="p-1.5 text-gray-500 hover:text-purple-600 hover:bg-purple-50 rounded transition-colors" title={t('mindmap.exportTxt')}>
              <Download className="w-3.5 h-3.5" />
            </button>
          )}
          <button onClick={handleFullscreen} className="p-1.5 text-gray-500 hover:text-purple-600 hover:bg-purple-50 rounded transition-colors" title={isFullscreen ? t('mindmap.exitFullscreen') : t('mindmap.fullscreen')}>
            {isFullscreen ? <Minimize className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>
        </div>

        <svg
          ref={svgRef}
          width={svgSize.w}
          height={svgSize.h}
          className="block"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
            transformOrigin: '0 0',
            transition: isDragging ? 'none' : 'transform 0.08s ease-out',
          }}
          xmlns="http://www.w3.org/2000/svg"
        >
          <defs>
            <filter id="mindmapShadow" x="-8%" y="-8%" width="124%" height="124%">
              <feDropShadow dx="0" dy="3" stdDeviation="4" floodColor="#00000018" />
            </filter>
          </defs>
          <rect x={0} y={0} width="100%" height="100%" fill="#FAFBFC" />
          {renderSvg(tree, 0, 0)}
        </svg>
      </div>
    </>
  );

  const cardContent = (
    <div
      ref={cardRef}
      className={`border border-purple-100/60 bg-white shadow-soft flex flex-col ${isFullscreen ? 'absolute inset-0 z-40 m-0 rounded-none border-0' : 'rounded-lg'}`}
    >
      {/* Header */}
      <div className={`flex items-center justify-between px-3 py-2 bg-purple-50 border-b border-purple-100 flex-shrink-0 ${isFullscreen ? '' : 'rounded-t-lg'}`}>
        {/* 3-switch toggle */}
        <div className="flex rounded-lg border border-purple-200/60 overflow-hidden bg-white">
          <button
            onClick={() => setMode('mindmap')}
            className={`px-2.5 py-1 text-xs font-medium transition-all duration-150 flex items-center gap-1.5 ${
              mode === 'mindmap'
                ? 'bg-purple-500 text-white shadow-sm'
                : 'text-gray-500 hover:text-purple-600 hover:bg-purple-50/50'
            }`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="5" r="2.5"/><path d="M12 7.5v4"/><circle cx="5" cy="16" r="2.5"/><circle cx="19" cy="16" r="2.5"/><path d="M12 11.5L7 14.5"/><path d="M12 11.5L17 14.5"/>
            </svg>
            {t('mindmap.modeMap')}
          </button>
          <button
            onClick={() => setMode('subtitle')}
            className={`px-2.5 py-1 text-xs font-medium transition-all duration-150 flex items-center gap-1.5 border-l border-purple-200/60 ${
              mode === 'subtitle'
                ? 'bg-purple-500 text-white shadow-sm'
                : 'text-gray-500 hover:text-purple-600 hover:bg-purple-50/50'
            }`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h8"/><path d="M8 9h2"/>
            </svg>
            {t('mindmap.modeSubtitle')}
          </button>
          <button
            onClick={() => setMode('raw')}
            className={`px-2.5 py-1 text-xs font-medium transition-all duration-150 flex items-center gap-1.5 border-l border-purple-200/60 ${
              mode === 'raw'
                ? 'bg-purple-500 text-white shadow-sm'
                : 'text-gray-500 hover:text-purple-600 hover:bg-purple-50/50'
            }`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="16 3 21 3 21 8"/><line x1="4" y1="11" x2="12" y2="11"/><line x1="4" y1="17" x2="12" y2="17"/><line x1="14" y1="20" x2="20" y2="14"/><polyline points="14 14 20 14 20 20"/>
            </svg>
            {t('mindmap.modeRaw')}
          </button>
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-0.5">
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="flex-1 min-h-0">
        {mode === 'mindmap' ? svgViewport : mode === 'subtitle' ? (
          <div
            className="overflow-auto p-4 text-sm text-gray-700 leading-relaxed"
            style={{ height: isFullscreen ? '100%' : '360px' }}
            dangerouslySetInnerHTML={{ __html: subtitleHtml }}
          />
        ) : (
          <div
            className="overflow-auto p-4 text-sm text-gray-600 leading-relaxed whitespace-pre-wrap font-mono"
            style={{ height: isFullscreen ? '100%' : '360px' }}
          >
            {rawPlainText}
          </div>
        )}
      </div>
    </div>
  );

  if (isFullscreen) {
    const anchor = document.getElementById('tab-content-area');
    if (anchor) {
      return createPortal(cardContent, anchor);
    }
  }

  return cardContent;
}

interface GenerateProps {
  subtitleText: string;
  sourceTitle?: string;
}

export function useMindMapGenerator() {
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [mindMapText, setMindMapText] = useState('');
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  const generate = useCallback(async ({ subtitleText, sourceTitle }: GenerateProps) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState('loading');
    setMindMapText('');
    setError('');

    try {
      const settings = await getSettings();
      const ai = settings.ai;
      if (!ai?.apiKey || !ai?.provider) {
        setError('AI 未配置，请在设置中配置 API Key');
        setState('error');
        return;
      }

      const endpoint = PROVIDER_ENDPOINTS[ai.provider];
      if (!endpoint) {
        setError(`不支持的 AI 服务商: ${ai.provider}`);
        setState('error');
        return;
      }

      const model = ai.model || DEFAULT_MODELS[ai.provider] || '';
      const maxChars = 6000;
      const truncatedText = subtitleText.length > maxChars
        ? subtitleText.slice(0, maxChars) + '\n…(内容过长，已截取前段)'
        : subtitleText;

      const systemPrompt = `你是资深思维导图专家。将以下视频字幕整理成思维导图结构的 Markdown。

规则：
1. ## 是一级分支（4~8个为宜），每个分支 - 是二级子节点（2~4个为宜）
2. 节点文字精简 ≤15字，用关键词而非完整句子
3. 二级节点用具体名词 / 动宾短语（如"增大光圈""降低ISO"）
4. 只输出 Markdown 树，不要任何解释

示例结构：
## 一、适用场景
 - 人像拍摄
 - 低光环境
## 二、参数设置
 - 曝光补偿+1
 - 光圈优先模式`;

      const userContent = sourceTitle
        ? `视频标题：${sourceTitle}\n\n字幕内容：\n${truncatedText}`
        : `字幕内容：\n${truncatedText}`;

      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${ai.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
          ],
          temperature: 0.3,
          max_tokens: 4096,
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        throw new Error(`AI 请求失败 (${resp.status})`);
      }

      const reader = resp.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let fullText = '';
      const buf = '';

      while (true) {
        if (controller.signal.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = (buf + chunk).split('\n');
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const json = JSON.parse(data);
            const content = json?.choices?.[0]?.delta?.content || '';
            if (content) {
              fullText += content;
              setMindMapText(fullText);
            }
          } catch { /* ignore malformed JSON */ }
        }
      }

      if (!controller.signal.aborted) {
        setState('done');
      }
    } catch (err: any) {
      if (err.name === 'AbortError') return;
      setError(err.message || 'AI 请求失败');
      setState('error');
    }
  }, []);

  return { state, mindMapText, error, generate, setState };
}
