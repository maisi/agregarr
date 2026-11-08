import logger from '@server/logger';
import { spawn } from 'child_process';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import type { TrailerDownloadOptions } from './types';

interface YoutubeSearchResult {
  id: string;
  title: string;
}

/** Apply the same optional cookies to search and download. */
function addYoutubeCookies(args: string[]): void {
  const cookiesPath = path.join(process.cwd(), 'config', 'youtube-cookies.txt');
  try {
    fs.accessSync(cookiesPath);
    args.push('--cookies', cookiesPath);
  } catch {
    // Cookies are optional; never read or log their contents.
  }
}

/** Search only the first result, without downloading media or using a shell. */
async function searchYoutube(
  query: string
): Promise<YoutubeSearchResult | null> {
  return new Promise((resolve, reject) => {
    const args = [
      '--ignore-config',
      '--dump-single-json',
      '--flat-playlist',
      '--skip-download',
      '--no-warnings',
    ];
    addYoutubeCookies(args);
    args.push('--', `ytsearch1:${query}`);
    const search = spawn('yt-dlp', args, { shell: false });
    let stdout = '';

    search.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    // Drain diagnostics, but do not retain or log search/cookie payloads.
    search.stderr.resume();
    search.on('error', () => reject(new Error('yt-dlp search process failed')));
    search.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`yt-dlp search exited with code ${code}`));
        return;
      }
      try {
        const result = JSON.parse(stdout);
        if (!result || !Array.isArray(result.entries)) {
          throw new Error('Invalid search result');
        }
        if (result.entries.length === 0) {
          resolve(null);
          return;
        }
        const first = result.entries[0];
        if (
          !first ||
          typeof first.id !== 'string' ||
          !/^[a-zA-Z0-9_-]{11}$/.test(first.id) ||
          typeof first.title !== 'string' ||
          !first.title.trim()
        ) {
          throw new Error('Invalid search metadata');
        }
        resolve({ id: first.id, title: first.title });
      } catch {
        // JSON parser messages can contain the raw search response.
        reject(new Error('Invalid yt-dlp search metadata'));
      }
    });
  });
}

/**
 * Copy static placeholder video
 * This is used as a fallback when no trailer is found
 */
async function copyPlaceholderVideo(outputPath: string): Promise<void> {
  logger.debug('Using static placeholder video', {
    label: 'PlaceholderService',
    outputPath,
  });

  try {
    // Use bundled placeholder video from public/assets
    const placeholderPath = path.join(
      process.cwd(),
      'public',
      'assets',
      'placeholder.mp4'
    );
    await fsPromises.copyFile(placeholderPath, outputPath);

    logger.info('Copied static placeholder video', {
      label: 'PlaceholderService',
      outputPath,
    });
  } catch (error) {
    logger.error('Failed to copy placeholder video', {
      label: 'PlaceholderService',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Download YouTube video using yt-dlp with duration filtering
 * Uses yt-dlp binary which is more reliable than JavaScript libraries for YouTube downloads
 * Duration filter rejects videos over 3.5 minutes (210s) to avoid compilation videos
 */
async function downloadWithYtDlp(
  videoUrl: string,
  outputPath: string,
  maxDuration = 210
): Promise<void> {
  return new Promise((resolve, reject) => {
    logger.debug('Downloading with yt-dlp', {
      label: 'PlaceholderService',
      videoUrl,
      outputPath,
      maxDuration,
    });

    // Build yt-dlp arguments with duration filter
    // Note: duration must be filtered using --match-filter, not in format selector
    const args = [
      '--break-on-reject',
      '--match-filter',
      `duration < ${maxDuration}`,
      '-f',
      'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080]',
      '--merge-output-format',
      'mp4',
      '-o',
      outputPath,
    ];

    addYoutubeCookies(args);

    args.push(videoUrl);

    // yt-dlp command with 1080p max resolution, duration filter, and automatic merging
    const ytdlp = spawn('yt-dlp', args, { shell: false });

    let stdoutOutput = '';

    ytdlp.stdout.on('data', (data) => {
      stdoutOutput += data.toString();
    });

    // Diagnostics may include cookie data; never retain or log them.
    ytdlp.stderr.resume();

    ytdlp.on('close', (code) => {
      if (code === 0) {
        logger.info('Successfully downloaded trailer with yt-dlp', {
          label: 'PlaceholderService',
          outputPath,
        });
        resolve();
      } else {
        // Check if this is a duration filter rejection (code 101)
        const isDurationFilterRejection =
          code === 101 && stdoutOutput.includes('does not pass filter');

        if (isDurationFilterRejection) {
          logger.info('Video rejected by duration filter (over 3.5 minutes)', {
            label: 'PlaceholderService',
            maxDuration: maxDuration,
          });
        } else {
          // Actual error (network, bot detection, etc.)
          logger.error('yt-dlp download failed', {
            label: 'PlaceholderService',
            code,
          });
        }

        reject(
          new Error(
            isDurationFilterRejection
              ? 'yt-dlp exited with code 101: does not pass filter'
              : `yt-dlp exited with code ${code}`
          )
        );
      }
    });

    ytdlp.on('error', () => {
      logger.error('yt-dlp spawn error', {
        label: 'PlaceholderService',
      });
      reject(new Error('yt-dlp download process failed'));
    });
  });
}

/**
 * Search for trailer on YouTube and download it
 */
async function searchAndDownloadTrailer(
  options: TrailerDownloadOptions
): Promise<void> {
  const { title, year, outputPath } = options;

  logger.info('Searching for YouTube trailer', {
    label: 'PlaceholderService',
    title,
    year,
  });

  try {
    // Search YouTube for official trailer
    const searchQuery = `${title}${year ? ` ${year}` : ''} official trailer`;
    const firstResult = await searchYoutube(searchQuery);

    if (!firstResult) {
      logger.warn('No YouTube trailers found, using fallback', {
        label: 'PlaceholderService',
        title,
      });
      await copyPlaceholderVideo(outputPath);
      return;
    }

    // Get the first result (usually the official trailer)
    const videoId = firstResult.id;
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    logger.info('Found YouTube trailer', {
      label: 'PlaceholderService',
      title,
      videoTitle: firstResult.title,
      videoId,
    });

    // Download trailer with yt-dlp (includes duration filter to reject videos over 3.5 minutes)
    const maxDuration = options.maxDuration || 210; // Default: 3.5 minutes
    logger.info('Downloading YouTube trailer with yt-dlp', {
      label: 'PlaceholderService',
      title,
      maxDuration,
    });

    await downloadWithYtDlp(videoUrl, outputPath, maxDuration);

    logger.info('Successfully downloaded 1080p trailer', {
      label: 'PlaceholderService',
      title,
      outputPath,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isDurationFilterRejection =
      errorMessage.includes('code 101') &&
      errorMessage.includes('does not pass filter');

    if (isDurationFilterRejection) {
      // Video was rejected by duration filter (too long)
      logger.info(
        'Trailer video too long (over 3.5 minutes), using placeholder instead',
        {
          label: 'PlaceholderService',
          title,
        }
      );
    } else {
      // Actual error (network, bot detection, etc.)
      logger.error('Failed to download YouTube trailer, using fallback', {
        label: 'PlaceholderService',
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
        title,
      });
    }
    // Fallback to placeholder video if download fails
    await copyPlaceholderVideo(outputPath);
  }
}

/**
 * Download trailer for a movie or TV show
 * Returns path to downloaded trailer file
 */
export async function downloadTrailer(
  title: string,
  year?: number,
  mediaType: 'movie' | 'tv' = 'movie'
): Promise<string> {
  const tempDir = path.join(process.cwd(), 'config', 'temp', 'trailers');

  try {
    // Ensure temp directory exists
    await fsPromises.mkdir(tempDir, { recursive: true });

    // Generate output filename
    const sanitizedTitle = title
      .replace(/[<>:"/\\|?*]/g, '')
      .replace(/\s+/g, '_');
    const yearStr = year ? `_${year}` : '';
    const filename = `${sanitizedTitle}${yearStr}_trailer.mp4`;
    const outputPath = path.join(tempDir, filename);

    // Check if trailer already exists
    try {
      await fsPromises.access(outputPath);
      logger.debug('Trailer already exists in cache', {
        label: 'PlaceholderService',
        title,
        outputPath,
      });
      return outputPath;
    } catch {
      // Trailer doesn't exist, download it
    }

    // Check if YouTube trailer downloads are disabled
    const { getSettings } = await import('@server/lib/settings');
    const settings = getSettings();
    const skipYoutubeDownload = settings.main.skipYoutubeTrailerDownloads;

    if (skipYoutubeDownload) {
      logger.info(
        'YouTube trailer downloads disabled - using hardcoded placeholder video',
        {
          label: 'PlaceholderService',
          title,
          year,
          mediaType,
        }
      );

      // Copy hardcoded placeholder video directly
      await copyPlaceholderVideo(outputPath);
      return outputPath;
    }

    logger.info('Downloading trailer', {
      label: 'PlaceholderService',
      title,
      year,
      mediaType,
    });

    await searchAndDownloadTrailer({
      title,
      year,
      outputPath,
      maxDuration: 210, // 3.5 minutes max (avoids compilation videos)
    });

    return outputPath;
  } catch (error) {
    logger.error('Failed to download trailer', {
      label: 'PlaceholderService',
      error: error instanceof Error ? error.message : String(error),
      title,
      year,
    });
    throw error;
  }
}
