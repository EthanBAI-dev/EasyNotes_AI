import { useState, useEffect, useCallback, useRef } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { MessageCircle, Headphones, MoreHorizontal, Youtube, Tv2, RefreshCw, ChevronDown, ChevronUp, Settings } from 'lucide-react';
import type { ImportProgress } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import type { Locale } from '@/lib/i18n';
import { PodcastSummary } from '@/components/PodcastSummary';
import { AISummary } from '@/components/AISummary';
import { YouTubeSummary } from '@/components/YouTubeSummary';
import { BilibiliSummary } from '@/components/BilibiliSummary';
import { getOpState } from '@/services/op-state';
import { LayersIcon } from '@/components/LayersIcon';
import { MorePanel } from '@/components/MorePanel';
import { BookmarkPanel } from '@/components/BookmarkPanel';
import { OnboardingTour } from '@/components/OnboardingTour';
import { MediaDropdown } from '@/components/MediaDropdown';

export default function App() {
  const { t, locale, setLocale } = useI18n();
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const [activeTab, setActiveTab] = useState('bilibili');
  const [initialPodcastUrl, setInitialPodcastUrl] = useState('');
  const [initialYouTubeUrl, setInitialYouTubeUrl] = useState('');
  const [initialBilibiliUrl, setInitialBilibiliUrl] = useState('');
  const [fetchTrigger, setFetchTrigger] = useState(0);

  const handleTabChange = useCallback(async (tab: string) => {
    const op = await getOpState();
    if (op?.active && tab !== activeTab) return;
    setActiveTab(tab);
    if (tab !== 'bilibili') setInitialBilibiliUrl('');
    if (tab !== 'youtube') setInitialYouTubeUrl('');
    if (tab !== 'podcast') setInitialPodcastUrl('');
  }, [activeTab]);

  const detectUrl = useCallback(async (url: string) => {
    if (!url) return;
    const op = await getOpState();
    if (op?.active) return;
    if (/podcasts\.apple\.com\//.test(url) || /xiaoyuzhoufm\.com\/(episode|podcast)\//.test(url)) {
      setActiveTab('podcast');
      setInitialPodcastUrl(url);
    } else if (/youtube\.com\/(watch|playlist|shorts|@|channel|c\/|user\/)|youtu\.be\//.test(url)) {
      setActiveTab('youtube');
      setInitialYouTubeUrl(url);
    } else if (/bilibili\.com\/(video|space)/.test(url)) {
      setActiveTab('bilibili');
      setInitialBilibiliUrl(url);
    } else if (/claude\.ai\/|chatgpt\.com\/|chat\.openai\.com\/|gemini\.google\.com\//.test(url)) {
      setActiveTab('claude');
    }
  }, []);

  const handleReadCurrentPage = useCallback(() => {
    setFetchTrigger((prev) => prev + 1);
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const url = tabs[0]?.url || '';
      detectUrl(url);
    });
  }, [detectUrl]);

  useEffect(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const url = tabs[0]?.url || '';
      detectUrl(url);
    });

    const handleTabUpdated = (_tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
      if (changeInfo.url && tab.active) {
        detectUrl(changeInfo.url);
      }
    };

    const handleTabActivated = (activeInfo: chrome.tabs.TabActiveInfo) => {
      chrome.tabs.get(activeInfo.tabId, (tab) => {
        if (tab.url) {
          detectUrl(tab.url);
        }
      });
    };

    chrome.tabs.onUpdated.addListener(handleTabUpdated);
    chrome.tabs.onActivated.addListener(handleTabActivated);

    return () => {
      chrome.tabs.onUpdated.removeListener(handleTabUpdated);
      chrome.tabs.onActivated.removeListener(handleTabActivated);
    };
  }, [detectUrl]);

  return (
    <div className="min-h-[480px] bg-surface">
      <div className="glass px-3.5 py-1.5 border-b border-border flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-1">
          <button
            onClick={handleReadCurrentPage}
            className="px-2 py-1 text-[10px] font-medium text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-md transition-all duration-150 btn-press flex items-center gap-1"
            title={t('app.readCurrentPage')}
          >
            <RefreshCw className="w-3 h-3" />
            {t('app.readCurrentPage')}
          </button>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setLocale(locale === 'zh' ? 'en' : 'zh')}
            className="px-1.5 py-1 text-[10px] font-medium text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-md transition-all duration-150 btn-press"
            title={locale === 'zh' ? 'Switch to English' : '切换到中文'}
          >
            {locale === 'zh' ? 'EN' : '中'}
          </button>
        </div>
      </div>

      <Tabs.Root value={activeTab} onValueChange={handleTabChange} className="flex flex-col">
        <Tabs.List className="flex glass border-b border-border px-2 gap-0.5" data-tour="tab-list">
          {/* Media Dropdown */}
          <MediaDropdown 
            activeTab={activeTab}
            onTabChange={handleTabChange}
            t={t}
          />
          
          {/* Web Tab */}
          <Tabs.Trigger
            value="bookmark"
            data-tour="tab-bookmark"
            className={cn(
              'flex-1 py-2 text-[11px] font-medium text-gray-400',
              'flex flex-col items-center gap-0.5 relative',
              'border-b-2 border-transparent',
              'hover:text-gray-500',
              'transition-all duration-200 ease-spring',
              'data-[state=active]:text-blue-600 data-[state=active]:border-blue-600',
            )}
          >
            <LayersIcon className="w-4 h-4" />
            {t('app.tabWeb')}
          </Tabs.Trigger>
          
          {/* AI Chat Tab */}
          <Tabs.Trigger
            value="claude"
            data-tour="tab-claude"
            className={cn(
              'flex-1 py-2 text-[11px] font-medium text-gray-400',
              'flex flex-col items-center gap-0.5 relative',
              'border-b-2 border-transparent',
              'hover:text-gray-500',
              'transition-all duration-200 ease-spring',
              'data-[state=active]:text-blue-600 data-[state=active]:border-blue-600',
            )}
          >
            <MessageCircle className="w-4 h-4" />
            {t('app.tabAIChat')}
          </Tabs.Trigger>

          {/* Settings Tab */}
          <Tabs.Trigger
            value="more"
            data-tour="tab-more"
            className={cn(
              'flex-1 py-2 text-[11px] font-medium text-gray-400',
              'flex flex-col items-center gap-0.5 relative',
              'border-b-2 border-transparent',
              'hover:text-gray-500',
              'transition-all duration-200 ease-spring',
              'data-[state=active]:text-blue-600 data-[state=active]:border-blue-600',
            )}
          >
            <Settings className="w-4 h-4" />
            {t('app.tabMore')}
          </Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content value="bilibili" className="p-4 animate-fade-in">
          <BilibiliSummary initialUrl={initialBilibiliUrl} onProgress={setImportProgress} fetchTrigger={fetchTrigger} />
        </Tabs.Content>

        <Tabs.Content value="youtube" className="p-4 animate-fade-in">
          <YouTubeSummary initialUrl={initialYouTubeUrl} onProgress={setImportProgress} fetchTrigger={fetchTrigger} />
        </Tabs.Content>

        <Tabs.Content value="podcast" className="p-4 animate-fade-in">
          <PodcastSummary initialUrl={initialPodcastUrl} />
        </Tabs.Content>

        <Tabs.Content value="bookmark" className="p-4 animate-fade-in">
          <BookmarkPanel onProgress={setImportProgress} />
        </Tabs.Content>

        <Tabs.Content value="claude" className="p-4 animate-fade-in">
          <AISummary onProgress={setImportProgress} />
        </Tabs.Content>

        <Tabs.Content value="more" className="p-4 animate-fade-in">
          <MorePanel onProgress={setImportProgress} />
        </Tabs.Content>
      </Tabs.Root>

      <OnboardingTour />
    </div>
  );
}
