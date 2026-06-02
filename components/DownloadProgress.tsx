import { useState, useEffect } from 'react';
import { getOpState, clearOpState } from '@/services/op-state';
import { DownloadOverlay } from '@/components/DownloadOverlay';

export function DownloadProgress() {
  const [opState, setOpState] = useState<Awaited<ReturnType<typeof getOpState>>>(null);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      while (active) {
        const state = await getOpState();
        setOpState(state);
        await new Promise((r) => setTimeout(r, 500));
      }
    };
    poll();
    return () => { active = false; };
  }, []);

  if (!opState) return null;

  const handleCancel = async () => {
    await clearOpState();
  };

  const phaseLabel =
    opState.phase === 'polishing' ? 'AI 处理中...'
    : opState.phase === 'importing' ? '导入中...'
    : '下载中...';

  return (
    <DownloadOverlay
      title={phaseLabel}
      detail={opState.title}
      current={opState.current}
      total={opState.total}
      iconColor="#4f46e5"
      iconBgColor="rgb(79 70 229 / 0.1)"
      progressColor="#4f46e5"
      onCancel={handleCancel}
    />
  );
}
