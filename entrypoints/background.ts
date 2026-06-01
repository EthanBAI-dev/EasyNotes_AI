import { parseRssFeed } from '@/services/rss-parser';
import { fetchPodcast, sanitizeFilename, buildFilename } from '@/services/podcast';
import { fetchYouTube, fetchYouTubeMore, fetchYouTubeTranscript } from '@/services/youtube';
import {
  fetchBilibiliVideo,
  fetchVideoSubtitle,
  sanitizeBilibiliFilename,
  parseBilibiliUrl,
  mergeBilibiliSubtitles,
  parseBilibiliSpaceUrl,
  fetchBilibiliUserVideos,
} from '@/services/bilibili';
import type { BilibiliVideoItem, BilibiliSourceInfo } from '@/services/bilibili';
import { polishSubtitlesWithChunks } from '@/services/ai-polish';
import { setOpState, clearOpState } from '@/services/op-state';
import JSZip from 'jszip';
import type { PodcastInfo, PodcastEpisode } from '@/services/podcast';

import {
  extractClaudeConversation,
} from '@/services/claude-conversation';
import {
  addBookmark,
  removeBookmark,
  removeBookmarks,
  moveBookmark,
  getBookmarks,
  getCollections,
  createCollection,
  isBookmarked,
} from '@/services/bookmarks';
import type { MessageType, MessageResponse } from '@/lib/types';

export default defineBackground(() => {
  console.log('EasyNotes_AI background service started');

  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

  chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
      chrome.tabs.create({ url: chrome.runtime.getURL('/welcome.html') });
    }
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name === 'podcast-download') {
      port.onMessage.addListener(async (msg) => {
        if (msg.type !== 'DOWNLOAD_PODCAST') return;

        const podcastInfo = msg.podcast as PodcastInfo;
        const episodes = msg.episodes as PodcastEpisode[];
        const sendProgress = (data: Record<string, unknown>) => {
          try { port.postMessage(data); } catch { /* disconnected */ }
          const phase = data.phase as string;
          if (phase === 'downloading' || phase === 'polishing') {
            setOpState({
              active: true,
              phase: phase === 'polishing' ? 'polishing' : 'downloading',
              kind: 'export',
              current: (data.current as number) || 0,
              total: (data.total as number) || 0,
              title: (data.title as string) || '',
              timestamp: Date.now(),
            });
          }
        };

        const folderName = sanitizeFilename(podcastInfo.name);
        console.log(`[podcast] Downloading ${episodes.length} episodes of "${podcastInfo.name}"`);

        try {
          for (let i = 0; i < episodes.length; i++) {
            const ep = episodes[i];
            const filename = `${folderName}/${buildFilename(i + 1, ep.title, ep.fileExtension)}`;
            sendProgress({ phase: 'downloading', current: i + 1, total: episodes.length, title: ep.title });
            console.log(`[podcast] ${i + 1}/${episodes.length}: ${ep.title}`);

            await new Promise<void>((resolve, reject) => {
              chrome.downloads.download(
                { url: ep.audioUrl, filename, conflictAction: 'uniquify' },
                (downloadId) => {
                  if (chrome.runtime.lastError) {
                    console.error(`[podcast] Download failed:`, chrome.runtime.lastError.message);
                    reject(new Error(chrome.runtime.lastError.message));
                  } else {
                    console.log(`[podcast] Download started: ${downloadId}`);
                    resolve();
                  }
                },
              );
            });
          }
          sendProgress({ phase: 'done' });
        } catch (err) {
          sendProgress({ phase: 'error', error: String(err) });
        }
      });
      return;
    }

    if (port.name === 'bilibili-download') {
      port.onMessage.addListener(async (msg) => {
        if (msg.type !== 'BILIBILI_DOWNLOAD_SEPARATE' && msg.type !== 'BILIBILI_DOWNLOAD_MERGED') return;

        const { videos, ownerName, desc, source, aiPolish, promptStyle } = msg as any;
        const isMerged = msg.type === 'BILIBILI_DOWNLOAD_MERGED';

        await setOpState({
          active: true,
          phase: 'downloading',
          kind: 'export',
          current: 0,
          total: videos.length,
          title: videos[0]?.part || videos[0]?.title || '',
          timestamp: Date.now(),
        });

        const sendProgress = (data: Record<string, unknown>) => {
          try { port.postMessage(data); } catch { /* disconnected */ }
        };

        try {
          if (isMerged) {
            const results: { video: any; markdown: string | null }[] = [];
            for (let i = 0; i < videos.length; i++) {
              const video = videos[i];
              sendProgress({ phase: 'downloading', current: i + 1, total: videos.length, title: video.part || video.title, bvid: video.bvid });
              const result = await fetchVideoSubtitle(video, ownerName, desc);
              results.push(result);
              if (i < videos.length - 1) {
                await new Promise(r => setTimeout(r, 1500));
              }
            }
            let mergedMd = mergeBilibiliSubtitles(results, source);
            if (aiPolish) {
              const allBodies = results.flatMap(r => (r as any).rawBody || []);
              const polished = await polishSubtitlesWithChunks(mergedMd, allBodies.length > 0 ? allBodies : undefined, (c, t) => {
                sendProgress({ phase: 'polishing', current: c, total: t, title: `AI 润色 ${c}/${t}` });
              }, promptStyle);
              if (!polished.success && polished.error) {
                sendProgress({ phase: 'error', error: `AI 润色失败：${polished.error}，请稍后重试` });
                clearOpState();
                return;
              }
              if (polished.success) mergedMd = polished.polished;
            }
            const filename = `${sanitizeBilibiliFilename(source.title)}_合并内容.md`;
            const encoded = btoa(unescape(encodeURIComponent(mergedMd)));
            const dataUrl = `data:text/markdown;base64,${encoded}`;
            await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
            sendProgress({ phase: 'done' });
            clearOpState();
          } else {
            let downloaded = 0; let skipped = 0;
            for (let i = 0; i < videos.length; i++) {
              const video = videos[i];
              sendProgress({ phase: 'downloading', current: i + 1, total: videos.length, title: video.part || video.title, bvid: video.bvid });
              const result = await fetchVideoSubtitle(video, ownerName, desc);
              if (!result.markdown) { skipped++; }
              else {
                let markdown = result.markdown;
                if (aiPolish) {
                  const polished = await polishSubtitlesWithChunks(markdown, result.rawBody, (c, t) => {
                    sendProgress({ phase: 'polishing', current: c, total: t, title: `${video.part || video.title} ${c}/${t}` });
                  }, promptStyle);
                  if (!polished.success && polished.error) {
                    sendProgress({ phase: 'error', error: `AI 润色失败：${polished.error}，请稍后重试` });
                    clearOpState();
                    return;
                  }
                  if (polished.success) markdown = polished.polished;
                }
                const displayTitle = video.part ? `${video.title} - ${video.part}` : video.title;
                const filename = `${sanitizeBilibiliFilename(displayTitle)}.md`;
                const encoded = btoa(unescape(encodeURIComponent(markdown)));
                const dataUrl = `data:text/markdown;base64,${encoded}`;
                await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
                downloaded++;
              }
              if (i < videos.length - 1) {
                await new Promise(r => setTimeout(r, 1500));
              }
            }
            sendProgress({ phase: 'done', downloaded, skipped });
            clearOpState();
          }
        } catch (err) {
          sendProgress({ phase: 'error', error: String(err) });
          clearOpState();
        }
      });
      return;
    }

    if (port.name === 'youtube-download') {
      port.onMessage.addListener(async (msg) => {
        if (msg.type !== 'YOUTUBE_DOWNLOAD_SEPARATE' && msg.type !== 'YOUTUBE_DOWNLOAD_MERGED') return;

        const { videos, source, aiPolish, promptStyle } = msg as any;
        const isMerged = msg.type === 'YOUTUBE_DOWNLOAD_MERGED';

        await setOpState({
          active: true,
          phase: 'downloading',
          kind: 'export',
          current: 0,
          total: videos.length,
          title: videos[0]?.title || '',
          timestamp: Date.now(),
        });

        const sendProgress = (data: Record<string, unknown>) => {
          try { port.postMessage(data); } catch { /* disconnected */ }
        };

        try {
          if (isMerged) {
            const results: { video: any; markdown: string; rawLines: any[] }[] = [];
            for (let i = 0; i < videos.length; i++) {
              const video = videos[i];
              sendProgress({ phase: 'downloading', current: i + 1, total: videos.length, title: video.title });
              const transcript = await fetchYouTubeTranscript(video.id);
              if (transcript.success) {
                results.push({ video, markdown: transcript.markdown, rawLines: transcript.lines });
              }
              if (i < videos.length - 1) {
                await new Promise(r => setTimeout(r, 2000));
              }
            }

            if (results.length === 0) {
              sendProgress({ phase: 'error', error: '所有视频均无字幕' });
              clearOpState();
              return;
            }

            const mergedLines: string[] = [];
            mergedLines.push(`# ${source?.title || 'YouTube 合集'}`, '', `**来源**: YouTube`, '');
            for (const r of results) {
              mergedLines.push('---', '', `## ${r.video.title}`, '', r.markdown, '');
            }

            let mergedMd = mergedLines.join('\n');
            if (aiPolish) {
              const allLines = results.flatMap(r => r.rawLines);
              const polished = await polishSubtitlesWithChunks(mergedMd, allLines.length > 0 ? allLines : undefined, (c, t) => {
                sendProgress({ phase: 'polishing', current: c, total: t, title: `AI 润色 ${c}/${t}` });
              }, promptStyle);
              if (!polished.success && polished.error) {
                sendProgress({ phase: 'error', error: `AI 润色失败：${polished.error}` });
                clearOpState();
                return;
              }
              if (polished.success) mergedMd = polished.polished;
            }

            const sourceName = (source?.title || 'youtube_collection').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
            const filename = `${sourceName}_合并字幕.md`;
            const encoded = btoa(unescape(encodeURIComponent(mergedMd)));
            const dataUrl = `data:text/markdown;base64,${encoded}`;
            await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
            sendProgress({ phase: 'done' });
            clearOpState();
          } else {
            let downloaded = 0; let skipped = 0;
            for (let i = 0; i < videos.length; i++) {
              const video = videos[i];
              sendProgress({ phase: 'downloading', current: i + 1, total: videos.length, title: video.title });
              const transcript = await fetchYouTubeTranscript(video.id);
              if (!transcript.success) { skipped++; }
              else {
                let markdown = transcript.markdown;
                if (aiPolish) {
                  const polished = await polishSubtitlesWithChunks(markdown, transcript.lines, (c, t) => {
                    sendProgress({ phase: 'polishing', current: c, total: t, title: `${video.title} ${c}/${t}` });
                  }, promptStyle);
                  if (!polished.success && polished.error) {
                    sendProgress({ phase: 'error', error: `AI 润色失败：${polished.error}` });
                    clearOpState();
                    return;
                  }
                  if (polished.success) markdown = polished.polished;
                }
                const safeTitle = video.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
                const filename = `${safeTitle}.md`;
                const encoded = btoa(unescape(encodeURIComponent(markdown)));
                const dataUrl = `data:text/markdown;base64,${encoded}`;
                await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
                downloaded++;
              }
              if (i < videos.length - 1) {
                await new Promise(r => setTimeout(r, 2000));
              }
            }
            sendProgress({ phase: 'done', downloaded, skipped });
            clearOpState();
          }
        } catch (err) {
          sendProgress({ phase: 'error', error: String(err) });
          clearOpState();
        }
      });
      return;
    }
  });

  chrome.runtime.onMessage.addListener(
    (
      message: MessageType,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response: MessageResponse) => void
    ) => {
      handleMessage(message)
        .then((data) => sendResponse({ success: true, data }))
        .catch((error) =>
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          })
        );

      return true;
    }
  );
});

async function handleMessage(message: MessageType): Promise<unknown> {
  const type = (message as any).type;

  if (type === 'FETCH_BILIBILI') {
    const { url } = message as { url: string };
    const parsed = parseBilibiliUrl(url);
    if (!parsed) throw new Error('无法解析的哔哩哔哩链接');
    return await fetchBilibiliVideo(parsed.bvid);
  }
  if (type === 'FETCH_BILIBILI_SPACE') {
    const { mid } = message as { mid: string };
    return await fetchBilibiliUserVideos(mid);
  }
  if (type === 'DOWNLOAD_BILIBILI_SUBTITLES') {
    const { videos, ownerName, desc } = message as any;
    let downloaded = 0; let skipped = 0;
    for (const video of videos) {
      const result = await fetchVideoSubtitle(video, ownerName, desc);
      if (!result.markdown) { skipped++; }
      else {
        const displayTitle = video.part ? `${video.title} - ${video.part}` : video.title;
        const filename = `${sanitizeBilibiliFilename(displayTitle)}.md`;
        const encoded = btoa(unescape(encodeURIComponent(result.markdown)));
        const dataUrl = `data:text/markdown;base64,${encoded}`;
        await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
        downloaded++;
      }
      if (videos.indexOf(video) < videos.length - 1) {
        await new Promise(r => setTimeout(r, 1500));
      }
    }
    return { downloaded, skipped };
  }
  if (type === 'DOWNLOAD_BILIBILI_ZIP') {
    const { videos, ownerName, desc } = message as any;
    const zip = new JSZip();
    let added = 0;
    for (const video of videos) {
      const result = await fetchVideoSubtitle(video, ownerName, desc);
      if (result.markdown) {
        const displayTitle = video.part ? `${video.title} - ${video.part}` : video.title;
        zip.file(`${sanitizeBilibiliFilename(displayTitle)}.md`, result.markdown);
        added++;
      }
      if (videos.indexOf(video) < videos.length - 1) {
        await new Promise(r => setTimeout(r, 1500));
      }
    }
    if (added > 0) {
      const content = await zip.generateAsync({ type: 'base64' });
      const zipFilename = `Bilibili_Subtitles_${new Date().getTime()}.zip`;
      await chrome.downloads.download({ url: `data:application/zip;base64,${content}`, filename: zipFilename, saveAs: false });
    }
    return { added };
  }
  if (type === 'DOWNLOAD_BILIBILI_MERGED') {
    const { videos, ownerName, desc, source } = message as any;
    const results = [];
    for (const video of videos) {
      const result = await fetchVideoSubtitle(video, ownerName, desc);
      results.push(result);
      if (videos.indexOf(video) < videos.length - 1) {
        await new Promise(r => setTimeout(r, 1500));
      }
    }
    const mergedMd = mergeBilibiliSubtitles(results, source);
    const filename = `${sanitizeBilibiliFilename(source.title)}_合并内容.md`;
    const encoded = btoa(unescape(encodeURIComponent(mergedMd)));
    const dataUrl = `data:text/markdown;base64,${encoded}`;
    await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
    return { success: true };
  }

  switch (message.type) {
    case 'PARSE_RSS':
      return await parseRssFeed(message.rssUrl);

    case 'GET_HISTORY':
      return [];

    case 'CLEAR_HISTORY':
      return true;

    case 'EXTRACT_CLAUDE_CONVERSATION':
      return await extractClaudeConversation(message.tabId);

    case 'FETCH_PODCAST':
      return await fetchPodcast(message.url, { count: message.count });

    case 'FETCH_YOUTUBE':
      return await fetchYouTube(message.url);

    case 'FETCH_YOUTUBE_MORE':
      return await fetchYouTubeMore(message.continuation);

    case 'FETCH_YOUTUBE_TRANSCRIPT':
      return await fetchYouTubeTranscript(message.videoId);

    case 'EXPORT_PDF':
    case 'DOWNLOAD_PODCAST':
      return { success: true };

    case 'ADD_BOOKMARK':
      return await addBookmark(message.url, message.title, message.favicon, message.collection);

    case 'REMOVE_BOOKMARK':
      await removeBookmark(message.id);
      return true;

    case 'REMOVE_BOOKMARKS':
      await removeBookmarks(message.ids);
      return true;

    case 'GET_BOOKMARKS':
      return await getBookmarks();

    case 'GET_COLLECTIONS':
      return await getCollections();

    case 'CREATE_COLLECTION':
      await createCollection(message.name);
      return true;

    case 'MOVE_BOOKMARK':
      await moveBookmark(message.id, message.collection);
      return true;

    case 'MOVE_BOOKMARKS':
      for (const id of message.ids) {
        await moveBookmark(id, message.collection);
      }
      return true;

    case 'IS_BOOKMARKED':
      return await isBookmarked(message.url);

    default:
      console.error('[background] Unknown message type:', (message as any).type, message);
      throw new Error(`Unknown message type: ${(message as any).type}`);
  }
}
