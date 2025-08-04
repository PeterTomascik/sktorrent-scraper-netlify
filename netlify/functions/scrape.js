// netlify/functions/scrape.js
const axios = require("axios");
const cheerio = require("cheerio");
const { decode } = require("entities");

// Hlavičky pre priame požiadavky na online.sktorrent.eu
const commonHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/114.0.0.0 Safari/537.36',
    'Accept-Encoding': 'identity'
};

function removeDiacritics(str) {
    return str.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

function shortenTitle(title, wordCount = 3) {
    return title.split(/\s+/).slice(0, wordCount).join(" ");
}

// Funkcie pre formatovanie, ktoré nepotrebujú meniť
function extractFlags(title) {
    const flags = [];
    if (/\bCZ\b/i.test(title)) flags.push("cz");
    if (/\bSK\b/i.test(title)) flags.push("sk");
    if (/\bEN\b/i.test(title)) flags.push("en");
    if (/\bHU\b/i.test(title)) flags.push("hu");
    if (/\bDE\b/i.test(title)) flags.push("de");
    if (/\bFR\b/i.test(title)) flags.push("fr");
    if (/\bIT\b/i.test(title)) flags.push("it");
    if (/\bES\b/i.test(title)) flags.push("es");
    if (/\bRU\b/i.test(title)) flags.push("ru");
    if (/\bPL\b/i.test(title)) flags.push("pl");
    if (/\bJP\b/i.test(title)) flags.push("jp");
    if (/\bCN\b/i.test(title)) flags.push("cn");
    return flags;
}

function formatTitle(label) {
    const qualityIcon = /720p|HD/i.test(label) ? "🟦 HD (720p)" :
                        /480p|SD/i.test(label) ? "🟨 SD (480p)" :
                        /360p|LD/i.test(label) ? "🟥 LD (360p)" : label;
    return `SKTonline ${qualityIcon}`;
}

function formatName(fullTitle, flagsArray) {
    const flagIcons = {
        cz: "🇨🇿", sk: "🇸🇰", en: "🇬🇧", hu: "🇭🇺", de: "🇩🇪", fr: "🇫🇷",
        it: "🇮🇹", es: "🇪🇸", ru: "🇷🇺", pl: "🇵🇱", jp: "🇯🇵", cn: "🇨🇳"
    };
    const iconStr = flagsArray.map(f => flagIcons[f]).filter(Boolean).join(" ");
    return fullTitle + "\n⚙️SKTonline" + (iconStr ? "\n" + iconStr : "");
}


// --- Hlavné scraping funkcie upravené pre priame volanie na sktorrent ---
async function searchOnlineVideos(query) {
    const searchUrl = `https://online.sktorrent.eu/search/videos?search_query=${encodeURIComponent(query)}`;
    console.log(`[SCRAPER] Hľadám '${query}' na ${searchUrl} (priamo)`);

    try {
        const res = await axios.get(searchUrl, { headers: commonHeaders });
        console.log(`[SCRAPER] Status vyhľadávania: ${res.status}`);

        const $ = cheerio.load(res.data);
        const links = [];

        // Logika scrapovania pre video IDs - ZMENA BOLA TU (odstránené div.video-item)
        $('a[href^="/video/"]').each((i, el) => {
            const href = $(el).attr('href');
            const match = href ? href.match(/\/video\/(\d+)\//) : null;
            if (match && match[1]) {
                const videoId = match[1];
                links.push(videoId);
            }
        });

        console.log(`[SCRAPER] Nájdených videí: ${links.length}`);
        return links;
    } catch (err) {
        console.error("[SCRAPER ERROR] Vyhľadávanie online videí zlyhalo:", err.message);
        return [];
    }
}

async function extractStreamsFromVideoId(videoId) {
    const videoUrl = `https://online.sktorrent.eu/video/${videoId}`;
    console.log(`[SCRAPER] Načítavam detaily videa: ${videoUrl} (priamo)`);

    try {
        const res = await axios.get(videoUrl, { headers: commonHeaders });
        console.log(`[SCRAPER] Status detailu videa: ${res.status}`);

        const $ = cheerio.load(res.data);
        const sourceTags = $('video source'); // Toto je stále správne
        const titleText = $('title').text().trim(); // Uistite sa, že získava titul
        console.log(`[SCRAPER DEBUG] Title text from page: "${titleText}"`);
        const flags = extractFlags(titleText);
        console.log(`[SCRAPER DEBUG] Extracted flags: ${flags.join(', ')}`);

        const streams = [];
        sourceTags.each((i, el) => {
            let src = $(el).attr('src');
            const label = $(el).attr('label') || 'Unknown';

            console.log(`[SCRAPER DEBUG] Raw source tag src: "${src}"`);

            // Agresívnejšie odstránenie viacerých lomítok, ale zachovanie protokolu
            if (src) {
                // Táto regex nahradí všetky sekvencie //+ (dve a viac lomítok) za jedno lomítko,
                // ale vynechá // v http:// alebo https://
                src = src.replace(/(https?:\/\/[^\/]+\/)(.+)/, (match, p1, p2) => {
                    return p1 + p2.replace(/\/\/+/g, '/');
                });
            }
            
            console.log(`[SCRAPER DEBUG] Processed source tag src: "${src}"`);

            if (src && src.endsWith('.mp4')) {
                console.log(`[SCRAPER] 🎞️ Nájdený stream: ${label} URL: ${src}`);
                streams.push({
                    title: formatName(titleText, flags),
                    name: formatTitle(label),
                    url: src
                });
            } else {
                console.log(`[SCRAPER DEBUG] Preskočený stream (nie .mp4 alebo chýba src): ${src}`);
            }
        });

        console.log(`[SCRAPER] Našiel som ${streams.length} streamov pre videoId=${videoId}`);
        return streams;
    } catch (err) {
        console.error("[SCRAPER ERROR] Chyba pri načítaní detailu videa:", err.message);
        return [];
    }
}


// --- HLAVNÁ HANDLER FUNKCIA PRE NETLIFY ---
exports.handler = async (event, context) => {
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            body: JSON.stringify({ message: "Metóda nie je povolená. Použite POST." }),
        };
    }

    let payload;
    try {
        payload = JSON.parse(event.body);
    } catch (error) {
        console.error("[SCRAPER ERROR] Chyba pri parsovaní JSON payloadu:", error.message);
        return {
            statusCode: 400,
            body: JSON.stringify({ message: "Neplatný JSON formát v tele požiadavky." }),
        };
    }

    const { imdbId, type, season, episode } = payload;

    if (!imdbId || !type) {
        return {
            statusCode: 400,
            body: JSON.stringify({ message: "Chýbajúce parametre: imdbId alebo type." }),
        };
    }

    console.log(`\n====== [NETLIFY FUNCTION] Požiadavka pre: type='${type}', id='${imdbId}:${season}:${episode}' ======`);

    async function getTitleFromIMDb(imdbId) {
        try {
            const url = `https://www.imdb.com/title/${imdbId}/`;
            console.log(`[SCRAPER] 🌐 IMDb Request: ${url}`);
            const res = await axios.get(url, { headers: commonHeaders });

            if (res.status === 404) {
                console.error("[SCRAPER ERROR] IMDb scraping zlyhal: stránka neexistuje (404)");
                return null;
            }

            const $ = cheerio.load(res.data);
            const titleRaw = $('title').text().split(' - ')[0].trim();
            const title = decode(titleRaw);
            const ldJson = $('script[type="application/ld+json"]').html();
            let originalTitle = title;
            if (ldJson) {
                const json = JSON.parse(ldJson);
                if (json && json.name) originalTitle = decode(json.name.trim());
            }

            console.log(`[SCRAPER] 🎬 IMDb title: ${title}, original: ${originalTitle}`);
            return { title, originalTitle };
        } catch (err) {
            console.error("[SCRAPER ERROR] IMDb scraping zlyhal:", err.message);
            return null;
        }
    }

    const titles = await getTitleFromIMDb(imdbId);
    if (!titles) {
        return {
            statusCode: 200,
            body: JSON.stringify({ streams: [] }),
        };
    }

    const { title, originalTitle } = titles;
    const queries = new Set();

    const baseTitles = [title, originalTitle].map(t => t.replace(/\(.*?\)/g, '').trim());
    for (const base of baseTitles) {
        const noDia = removeDiacritics(base);
        const short = shortenTitle(noDia);
        const short1 = shortenTitle(noDia, 1);

        if (type === 'series' && season && episode) {
            const epTag1 = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
            const epTag2 = `${season}x${episode}`;
            [base, noDia, short, short1].forEach(b => {
                queries.add(`${b} ${epTag1}`);
                queries.add(`${b} ${epTag2}`);
            });
        } else {
            [base, noDia, short].forEach(b => {
                queries.add(b);
            });
        }
    }

    let allStreams = [];
    let attempt = 1;
    for (const q of queries) {
        console.log(`[SCRAPER] Pokus ${attempt++}: '${q}'`);
        const videoIds = await searchOnlineVideos(q);
        for (const vid of videoIds) {
            const streams = await extractStreamsFromVideoId(vid);
            allStreams.push(...streams);
        }
        if (allStreams.length > 0) break;
    }

    console.log(`[SCRAPER] Odosielam ${allStreams.length} streamov.`);

    return {
        statusCode: 200,
        body: JSON.stringify({ streams: allStreams }),
    };
};
