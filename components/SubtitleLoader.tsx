import { Loader2, AlertCircle, FileText } from 'lucide-react';

export type SubtitleState = 'idle' | 'loading' | 'loaded' | 'error';

interface Props {
  state: SubtitleState;
  /** Markdown 字幕文本 */
  content?: string;
  /** 错误提示文案 */
  errorMessage?: string;
  /** 容器最小高度 */
  minHeight?: number;
  /** 是否使用骨架屏风格（默认 false = 转圈） */
  useSkeleton?: boolean;
  /** 自定义空状态文案 */
  emptyMessage?: string;
}

function SkeletonLoader() {
  return (
    <div className="space-y-3 animate-pulse px-2">
      {[...Array(6)].map((_, i) => (
        <div key={i} className="flex gap-3">
          <div className="h-3 bg-gray-200 rounded w-8 flex-shrink-0" />
          <div
            className="h-3 bg-gray-200 rounded"
            style={{ width: `${60 + Math.random() * 35}%` }}
          />
        </div>
      ))}
      <div className="flex gap-3">
        <div className="h-3 bg-gray-200 rounded w-8 flex-shrink-0" />
        <div className="h-3 bg-gray-200 rounded w-3/4" />
      </div>
    </div>
  );
}

export function SubtitleLoader({
  state,
  content,
  errorMessage = '视频没有字幕',
  minHeight = 200,
  useSkeleton = false,
  emptyMessage = '视频没有字幕',
}: Props) {
  if (state === 'loading') {
    return (
      <div
        className="flex items-center justify-center border border-gray-100 rounded-lg bg-gray-50/50"
        style={{ minHeight }}
      >
        {useSkeleton ? (
          <SkeletonLoader />
        ) : (
          <div className="flex flex-col items-center gap-2 text-gray-400">
            <Loader2 className="w-6 h-6 animate-spin" />
            <span className="text-xs">正在加载字幕…</span>
          </div>
        )}
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div
        className="flex flex-col items-center justify-center gap-2 border border-amber-100 rounded-lg bg-amber-50/50 p-4"
        style={{ minHeight: Math.min(minHeight, 120) }}
      >
        <AlertCircle className="w-5 h-5 text-amber-500" />
        <span className="text-xs text-amber-600">{errorMessage}</span>
      </div>
    );
  }

  if (state === 'loaded' && content) {
    return (
      <div
        className="overflow-auto border border-gray-100 rounded-lg bg-white p-3"
        style={{ maxHeight: Math.max(minHeight, 360) }}
      >
        <div className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap font-sans">
          {content}
        </div>
      </div>
    );
  }

  // idle or empty
  return (
    <div
      className="flex flex-col items-center justify-center gap-2 border border-gray-100 rounded-lg bg-gray-50/30"
      style={{ minHeight: Math.min(minHeight, 120) }}
    >
      <FileText className="w-5 h-5 text-gray-300" />
      <span className="text-xs text-gray-400">{emptyMessage}</span>
    </div>
  );
}
