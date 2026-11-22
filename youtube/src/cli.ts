import { createYouTubeService, YouTubeError, sanitize } from './service.ts';

try {
  const service = createYouTubeService();
  const command = process.argv[2];
  if (command === 'status') console.log(JSON.stringify(await service.connectionStatus(), null, 2));
  else if (command === 'videos') {
    const r = await service.listVideos();
    console.log(JSON.stringify(sanitize(r.videos.map(v => ({ id: v.id, title: v.title, published_at: v.published_at, duration_seconds: v.duration_seconds,
      views: v.public.find((o: any) => o.name === 'viewCount')?.value ?? null }))), null, 2));
  } else throw new Error('Usage: npm run status | npm run videos');
} catch (e) { console.error(e instanceof YouTubeError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : 'Failed.'); process.exitCode = 1; }
