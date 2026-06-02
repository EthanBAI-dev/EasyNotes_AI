import { X, Download, Loader2 } from 'lucide-react';

interface DownloadOverlayProps {
  title: string;
  detail?: string;
  current: number;
  total: number;
  iconColor: string;
  iconBgColor: string;
  progressColor: string;
  onCancel: () => void;
}

export function DownloadOverlay({
  title,
  detail,
  current,
  total,
  iconColor,
  iconBgColor,
  progressColor,
  onCancel,
}: DownloadOverlayProps) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-xl border border-gray-100 p-6 w-[280px] text-center space-y-4 animate-fade-in">
        <div
          className="w-12 h-12 mx-auto rounded-full flex items-center justify-center"
          style={{ backgroundColor: iconBgColor }}
        >
          <Download className="w-6 h-6" style={{ color: iconColor }} />
        </div>
        <div>
          <p className="text-sm font-medium text-gray-800">{title}</p>
          {detail && (
            <p className="text-xs text-gray-400 mt-1 truncate">{detail}</p>
          )}
          <p className="text-xs text-gray-400 mt-0.5">
            {current}/{total}
          </p>
        </div>
        <div className="w-full bg-gray-100 rounded-full h-1.5 overflow-hidden">
          <div
            className="h-1.5 rounded-full transition-all duration-500"
            style={{ width: `${pct}%`, backgroundColor: progressColor }}
          />
        </div>
        <div className="flex items-center justify-center gap-1">
          <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: iconColor }} />
          <span className="text-xs text-gray-400">处理中…</span>
        </div>
        <button
          onClick={onCancel}
          className="w-full py-2 text-xs font-medium text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg border border-gray-200 transition-colors duration-150 flex items-center justify-center gap-1"
        >
          <X className="w-3 h-3" />
          取消操作
        </button>
      </div>
    </div>
  );
}
