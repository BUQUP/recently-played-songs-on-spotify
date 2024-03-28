// Import necessary modules and packages
import 'dotenv/config'; // Loads environment variables from a .env file
import fs from 'fs'; // File system module for interacting with the file system
import { JSONFile, Low } from 'lowdb'; // LowDB for local JSON database management
import fetch from 'node-fetch'; // Fetch API for making HTTP requests

// Retrieve necessary environment variables
const {
  CLIENT_ID,
  CLIENT_SECRET,
  REFRESH_TOKEN,
} = process.env;

// Main function to execute the script
async function main() {
  // Check if required environment variables are present
  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
    console.error('Missing environment variables');
    return process.exit(1); // Exit with error status
  }

  // Create a temporary directory
  const tempDir = fs.mkdtempSync('/tmp/');
  console.log(`Temporary directory created: ${tempDir}`);

  // Initialize LowDB for storing cursor information
  const infoSchemafileAdapter = new JSONFile('./info-schema.json');
  const infoSchemaDB = new Low(infoSchemafileAdapter);

  // Read existing data from the database
  await infoSchemaDB.read();

  // Ensure data structure exists
  if (!infoSchemaDB.data) {
    infoSchemaDB.data = {};
  }

  // Obtain access token using refresh token
  const accessToken = await getAccessToken(REFRESH_TOKEN, CLIENT_ID, CLIENT_SECRET);

  // Retrieve cursor information from the database
  const cursorAfter = infoSchemaDB.data.cursor?.after ?? null;

  // Fetch recently played tracks from Spotify API
  const data = await getRecentlyPlayedTracks(accessToken, 50, cursorAfter);

  // Check if new tracks were found
  if (data.items.length === 0) {
    console.log('No new tracks found');
    return process.exit(0); // Exit with success status
  }

  // Update cursor information
  const newCursorAfter = data.cursors.after;
  console.log(`previous cursor: ${cursorAfter}`);
  console.log(`new cursor: ${newCursorAfter}`);

  // Sort and group recently played tracks by date
  const sortedItems = data.items.sort((a, b) => new Date(a.played_at) - new Date(b.played_at));
  const itemsByDate = groupByDate(sortedItems, item => item.played_at.split('T')[0]);

  // Process each date group
  const dates = Object.keys(itemsByDate);
  for (const date of dates) {
    const items = itemsByDate[date];
    const tempFilePath = `${tempDir}/${date}.json`;
    const fileAdapter = new JSONFile(tempFilePath);
    const db = new Low(fileAdapter);

    // Read existing data from the local database
    await db.read();

    // Update or initialize data for the date
    if (db.data) {
      db.data.items.push(...items);
    } else {
      db.data = {
        items: items,
      };
    }

    // Write data to the local database
    await db.write();
    console.log(`wrote ${items.length} items to ${tempFilePath}`);

    // Generate HTML for recently played tracks
    await generateRecentlyPlayedHTML(tempFilePath);
  }

  // Update cursor information in the global schema
  if (newCursorAfter) {
    infoSchemaDB.data.cursor = { after: newCursorAfter };
  }

  // Write updated cursor information to the global schema
  await infoSchemaDB.write();
}

// Generate HTML content for recently played tracks
async function generateRecentlyPlayedHTML(tempFilePath) {
  try {
    // Read data from the temporary JSON file
    const dateData = JSON.parse(fs.readFileSync(tempFilePath, 'utf-8'));

    // Validate data structure
    if (!dateData || !dateData.items || !Array.isArray(dateData.items)) {
      throw new Error('Invalid data structure in JSON file');
    }

    // Extract track information from the data
    const recentlyPlayed = dateData.items.map(item => item.track);

    // Reverse the order of recently played songs
    recentlyPlayed.reverse();

    // Ensure only the last 10 entries are included
    const lastTenPlayed = recentlyPlayed.slice(0, 10);

    // Construct HTML table for displaying track information
    let htmlContent = '<table style="border-collapse: collapse; width: 100%;">';
    htmlContent += '<tr style="background-color: #f2f2f2;">';
    htmlContent += '<th style="padding: 8px; text-align: left;">Album Artwork</th>';
    htmlContent += '<th style="padding: 8px; text-align: left;">Track Name</th>';
    htmlContent += '<th style="padding: 8px; text-align: left;">Artists</th>';
    htmlContent += '<th style="padding: 8px; text-align: left;">Album</th>';
    htmlContent += '</tr>';

    // Populate table rows with track information
    lastTenPlayed.forEach((track, index) => {
      const album = track.album;
      const artistNames = track.artists.map(artist => artist.name).join(', ');
      const albumImage = album.images.find(img => img.width === 64);

      htmlContent += '<tr style="background-color: ' + (index % 2 === 0 ? '#ffffff' : '#f2f2f2') + ';">';
      htmlContent += '<td style="padding: 8px;"><img src="' + albumImage.url + '" alt="' + album.name + '" style="width: 64px; height: 64px;"></td>';
      htmlContent += '<td style="padding: 8px;">' + track.name + '</td>';
      htmlContent += '<td style="padding: 8px;">' + artistNames + '</td>';
      htmlContent += '<td style="padding: 8px;"><a href="' + album.external_urls.spotify + '" target="_blank">' + album.name + '</a></td>';
      htmlContent += '</tr>';
    });

    htmlContent += '</table>';

    // Write HTML content to README file
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

// Obtain access token using refresh token
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

// Fetch recently played tracks from Spotify API
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

// Group items by date using a custom date extractor function
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

// Execute the main function
main();
