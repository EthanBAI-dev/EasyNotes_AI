import type { BilibiliVideoItem, BilibiliSourceInfo } from '@/services/bilibili';

export interface ImportProgress {
  total: number;
  completed: number;
  current?: { url: string; title?: string };
  items: { url: string; title?: string; status: 'pending' | 'success' | 'error' }[];
}

export interface RssFeedItem {
  url: string;
  title: string;
  pubDate?: string;
}

export interface YouTubeVideoItem {
  id: string;
  url: string;
  title: string;
  publishedAt?: string;
}

export interface YouTubeSourceInfo {
  type: 'video' | 'playlist' | 'channel';
  id: string;
  title: string;
  videoCount?: number;
}

export interface YouTubeResult {
  source: YouTubeSourceInfo;
  videos: YouTubeVideoItem[];
  continuation?: string;
}

export type MessageType =
  | { type: 'PARSE_RSS'; rssUrl: string }
  | { type: 'GET_HISTORY'; limit?: number }
  | { type: 'CLEAR_HISTORY' }
  | { type: 'EXTRACT_CLAUDE_CONVERSATION'; tabId: number }
  | { type: 'EXPORT_PDF'; blobUrl: string; title: string }
  | { type: 'FETCH_PODCAST'; url: string; count?: number }
  | { type: 'FETCH_YOUTUBE'; url: string }
  | { type: 'FETCH_YOUTUBE_MORE'; continuation: string }
  | { type: 'FETCH_BILIBILI'; url: string }
  | { type: 'FETCH_BILIBILI_SPACE'; mid: string }
  | { type: 'DOWNLOAD_BILIBILI_SUBTITLES'; videos: BilibiliVideoItem[]; ownerName: string; desc: string }
  | { type: 'DOWNLOAD_BILIBILI_ZIP'; videos: BilibiliVideoItem[]; ownerName: string; desc: string }
  | { type: 'DOWNLOAD_BILIBILI_MERGED'; videos: BilibiliVideoItem[]; ownerName: string; desc: string; source: BilibiliSourceInfo }
  | { type: 'DOWNLOAD_PODCAST' }
  | { type: 'ADD_BOOKMARK'; url: string; title: string; favicon?: string; collection?: string }
  | { type: 'REMOVE_BOOKMARK'; id: string }
  | { type: 'REMOVE_BOOKMARKS'; ids: string[] }
  | { type: 'MOVE_BOOKMARK'; id: string; collection: string }
  | { type: 'MOVE_BOOKMARKS'; ids: string[]; collection: string }
  | { type: 'GET_BOOKMARKS' }
  | { type: 'GET_COLLECTIONS' }
  | { type: 'CREATE_COLLECTION'; name: string }
  | { type: 'IS_BOOKMARKED'; url: string };

export type MessageResponse =
  | { success: true; data: unknown }
  | { success: false; error: string };

export type ClaudeRole = 'human' | 'assistant';

export interface ClaudeMessage {
  id: string;
  role: ClaudeRole;
  content: string;
  timestamp?: string;
}

export interface QAPair {
  id: string;
  question: string;
  answer: string;
  questionTimestamp?: string;
  answerTimestamp?: string;
}

export interface ClaudeConversation {
  id: string;
  title: string;
  url: string;
  messages: ClaudeMessage[];
  pairs?: QAPair[];
  extractedAt: number;
}
