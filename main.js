import 'dotenv/config';
import fs from 'fs';
import { JSONFile, Low } from 'lowdb';
import fetch from 'node-fetch';

const {
  CLIENT_ID,
  CLIENT_SECRET,
  REFRESH_TOKEN,
} = process.env;

async function main() {
  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
    console.error('Missing environment variables');
    return process.exit(1);
  }

  const tempDir = fs.mkdtempSync('/tmp/');
  console.log(`Temporary directory created: ${tempDir}`);

  const infoSchemafileAdapter = new JSONFile('./info-schema.json');
  const infoSchemaDB = new Low(infoSchemafileAdapter);

  await infoSchemaDB.read();

  if (!infoSchemaDB.data) {
    infoSchemaDB.data = {};
  }

  const accessToken = await getAccessToken(REFRESH_TOKEN, CLIENT_ID, CLIENT_SECRET);
  const cursorAfter = infoSchemaDB.data.cursor?.after ?? null;
  const data = await getRecentlyPlayedTracks(accessToken, 50, cursorAfter);

  if (data.items.length === 0) {
    console.log('No new tracks found');
    return process.exit(0);
  }

  const newCursorAfter = data.cursors.after;
  console.log(`previous cursor: ${cursorAfter}`);
  console.log(`new cursor: ${newCursorAfter}`);

  // remove this code and it's references since it messes up with the order
  const sortedItems = data.items.sort((a, b) => new Date(a.played_at) - new Date(b.played_at));
  const itemsByDate = groupByDate(sortedItems, item => item.played_at.split('T')[0]);

  const dates = Object.keys(itemsByDate);
  for (const date of dates) {
    const items = itemsByDate[date];
    const tempFilePath = `${tempDir}/${date}.json`;
    const fileAdapter = new JSONFile(tempFilePath);
    const db = new Low(fileAdapter);

    await db.read();

    if (db.data) {
      db.data.items.push(...items);
    } else {
      db.data = {
        items: items,
      };
    }

    await db.write();
    console.log(`wrote ${items.length} items to ${tempFilePath}`);

    await generateRecentlyPlayedHTML(tempFilePath);
  }

  if (newCursorAfter) {
    infoSchemaDB.data.cursor = { after: newCursorAfter };
  }

  await infoSchemaDB.write();
}

async function generateRecentlyPlayedHTML(tempFilePath) {
  try {
    const dateData = JSON.parse(fs.readFileSync(tempFilePath, 'utf-8'));

    if (!dateData || !dateData.items || !Array.isArray(dateData.items)) {
      throw new Error('Invalid data structure in JSON file');
    }
    
    const recentlyPlayed = dateData.items.map(item => item.track);

    // Reverse the order of recently played songs
    recentlyPlayed.reverse();

    // Ensure only the last 10 entries are included
    const lastTenPlayed = recentlyPlayed.slice(0, 10);

    let htmlContent = '<table style="border-collapse: collapse; width: 100%;">';
    htmlContent += '<tr style="background-color: #f2f2f2;"><th style="padding: 8px; text-align: left;">Album Artwork</th><th style="padding: 8px; text-align: left;">Track Name</th><th style="padding: 8px; text-align: left;">Artists</th><th style="padding: 8px; text-align: left;">Album</th></tr>';
    lastTenPlayed.forEach((track, index) => {
      const album = track.album;
      const artistNames = track.artists.map(artist => artist.name).join(', ');
      const albumImage = album.images.find(img => img.width === 64);

      htmlContent += `<tr style="background-color: ${index % 2 === 0 ? '#ffffff' : '#f2f2f2'};"><td style="padding: 8px;"><img src="${albumImage.url}" alt="${album.name}" style="width: 64px; height: 64px;"></td><td style="padding: 8px;">${track.name}</td><td style="padding: 8px;">${artistNames}</td><td style="padding: 8px;"><a href="${album.external_urls.spotify}" target="_blank">${album.name}</a></td></tr>`;
    });
    htmlContent += '</table>';

    fs.writeFileSync('README.md', htmlContent, 'utf-8');

    console.log(`README.md has been generated with recently played tracks for ${tempFilePath}`);

    // Update the JSON file with the reordered songs
    dateData.items = lastTenPlayed.reverse(); // Reverse back to original order before updating
    fs.writeFileSync(tempFilePath, JSON.stringify(dateData, null, 2), 'utf-8');
    console.log(`Songs reordered in ${tempFilePath}`);
  } catch (error) {
    console.error(`Error generating README: ${error.message}`);
  }
}

async function getAccessToken(refresh_token, client_id, client_secret) {
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refresh_token,
      client_id: client_id,
      client_secret: client_secret,
    }).toString(),
  });

  const data = await response.json();
  const accessToken = data.access_token;

  return accessToken;
}

async function getRecentlyPlayedTracks(accessToken, limit = 10, after = null) {
  const serachParams = new URLSearchParams({
    limit: limit,
  });

  if (after) {
    serachParams.append('after', after);
  }

  const response = await fetch(`https://api.spotify.com/v1/me/player/recently-played?${serachParams.toString()}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const data = await response.json();
  return data;
}

function groupByDate(items, dateExtractor) {
  const groups = {};
  items.forEach(item => {
    const date = dateExtractor(item);
    if (!groups[date]) {
      groups[date] = [];
    }
    groups[date].push(item);
  });
  return groups;
}

main();