'use strict';

const { readYandexMusicNowPlaying, readYandexMusicArt } = require('../src/modules/yandex-music/windowsMedia');

(async () => {
    const now = await readYandexMusicNowPlaying();
    console.log('now', now);
    const art = await readYandexMusicArt();
    console.log('art', art.ok, art.contentType, art.bytes && art.bytes.length);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
