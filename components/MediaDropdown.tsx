import { useState, useRef, useEffect, useCallback } from 'react';
import { Tv2, Youtube, Headphones } from 'lucide-react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

interface MediaDropdownProps {
  activeTab: string;
  onTabChange: (tab: string) => void;
  t: (key: string) => string;
}

export function MediaDropdown({ activeTab, onTabChange, t }: MediaDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const mediaOptions = [
    { value: 'bilibili', icon: Tv2, label: t('app.tabBilibili'), color: 'text-blue-600', borderColor: 'border-blue-600' },
    { value: 'youtube', icon: Youtube, label: t('app.tabYouTube'), color: 'text-red-600', borderColor: 'border-red-600' },
    { value: 'podcast', icon: Headphones, label: t('app.tabPodcast'), color: 'text-purple-600', borderColor: 'border-purple-600' },
  ];

  const currentMedia = mediaOptions.find(option => option.value === activeTab) || mediaOptions[0];

  const updatePosition = useCallback(() => {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      updatePosition();
      window.addEventListener('resize', updatePosition);
      window.addEventListener('scroll', updatePosition);
    }
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition);
    };
  }, [isOpen, updatePosition]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerRef.current && !containerRef.current.contains(event.target as Node) &&
        !(event.target as Element)?.closest('.media-dropdown-portal')
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleMediaSelect = (value: string) => {
    onTabChange(value);
    setIsOpen(false);
  };

  const isMediaActive = ['bilibili', 'youtube', 'podcast'].includes(activeTab);

  return (
    <div className="relative flex-1" ref={containerRef}>
      <button
        ref={triggerRef}
        onClick={() => {
          updatePosition();
          setIsOpen(!isOpen);
        }}
        className={cn(
          'w-full py-2 text-[11px] font-medium',
          'flex flex-col items-center gap-0.5 relative',
          'border-b-2 transition-all duration-200 ease-spring',
          'hover:text-gray-500',
          isMediaActive 
            ? `${currentMedia.color} ${currentMedia.borderColor}`
            : 'text-gray-400 border-transparent',
        )}
      >
        <currentMedia.icon className="w-4 h-4" />
        <div className="flex items-center gap-0.5">
          <span>{t('app.tabMedia')}</span>
          <span className={cn(
            'w-0 h-0',
            'border-l-[3px] border-r-[3px] border-t-[4px]',
            'border-l-transparent border-r-transparent',
            isMediaActive ? 'border-t-current' : 'border-t-gray-400',
          )} />
        </div>
      </button>

      {isOpen && createPortal(
        <div
          className="media-dropdown-portal"
          style={{
            position: 'fixed',
            top: pos.top,
            left: pos.left,
            width: pos.width,
            zIndex: 2147483647,
          }}
        >
          <div className="bg-white border border-gray-200 rounded-lg shadow-xl overflow-hidden">
            {mediaOptions.map(({ value, icon: Icon, label, color }) => (
              <button
                key={value}
                onClick={() => handleMediaSelect(value)}
                className={cn(
                  'w-full px-3 py-2 text-[11px] font-medium flex items-center gap-2',
                  'hover:bg-gray-50 transition-colors duration-150',
                  activeTab === value ? `${color} bg-gray-50` : 'text-gray-600'
                )}
              >
                <Icon className="w-4 h-4" />
                {label}
              </button>
            ))}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
