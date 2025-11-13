import express from 'express';
import multer from 'multer';
import mammoth from 'mammoth';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import 'dotenv/config';

// --- Gemini API Configuration ---
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${process.env.API_KEY}`;
// ---

// --- Server Setup ---
const app = express();
const port = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --- Middleware ---
app.use(express.json());
app.use(express.static(join(__dirname, 'Public'))); // Use 'Public' (uppercase)
const upload = multer({ storage: multer.memoryStorage() }); // Store files in memory

// --- Global variable to cache research text ---
let researchTextCache = "";
let researchFilesCache = []; // To store file names for context

// --- Helper Function for API Calls ---
async function callGemini(payload, retryCount = 3) {
  for (let attempt = 0; attempt < retryCount; attempt++) {
    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API call failed with status: ${response.status} - ${errorText}`);
      }

      const result = await response.json();

      if (!result.candidates || !result.candidates[0] || !result.candidates[0].content) {
        console.error('Invalid API response:', JSON.stringify(result));
        throw new Error('Invalid response from AI API');
      }

      const safetyRatings = result.candidates[0].safetyRatings;
      if (safetyRatings) {
        const blockedRating = safetyRatings.find(rating => rating.blocked);
        if (blockedRating) {
          throw new Error(`API call blocked due to safety rating: ${blockedRating.category}`);
        }
      }
      
      const extractedJsonText = result.candidates[0].content.parts[0].text;
      // This is line 59, where the error was happening
      return JSON.parse(extractedJsonText); // Return the parsed JSON

    } catch (error) {
      console.log(`Attempt ${attempt + 1} failed:`, error.message);
      if (attempt >= retryCount - 1) {
        throw error; // Throw the last error
      }
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  throw new Error('All API retry attempts failed.');
}

// --- Main Endpoint: /generate-chart ---
// This endpoint now does ONE AI call to get the *visual chart data only*.
app.post('/generate-chart', upload.array('researchFiles'), async (req, res) => {
  const userPrompt = req.body.prompt;
  researchTextCache = ""; // Clear cache for new request
  researchFilesCache = []; // Clear cache

  // 1. Extract text from uploaded files (Sort for determinism)
  try {
    if (req.files) {
      const sortedFiles = req.files.sort((a, b) => a.originalname.localeCompare(b.originalname));
      for (const file of sortedFiles) {
        researchTextCache += `\n\n--- Start of file: ${file.originalname} ---\n`;
        researchFilesCache.push(file.originalname);
        if (file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
          const result = await mammoth.extractRawText({ buffer: file.buffer });
          researchTextCache += result.value;
        } else {
          researchTextCache += file.buffer.toString('utf8');
        }
        researchTextCache += `\n--- End of file: ${file.originalname} ---\n`;
      }
    }
  } catch (e) {
    console.error("File extraction error:", e);
    return res.status(500).json({ error: "Error processing uploaded files." });
  }

  // 2. Define the *single, powerful* system prompt
  // --- NEW, MORE PRECISE SANITIZATION RULE ---
  const geminiSystemPrompt = `You are an expert project management analyst. Your job is to analyze a user's prompt and research files to build a complete Gantt chart data object.
  
  You MUST respond with *only* a valid JSON object matching the schema.
  
  **CRITICAL LOGIC:**
  1.  **TIME HORIZON:** First, check the user's prompt for an *explicitly requested* time range (e.g., "2020-2030").
      - If found, use that range.
      - If NOT found, find the *earliest* and *latest* date in all the research to create the range.
  2.  **TIME INTERVAL:** Based on the *total duration* of that range, you MUST choose an interval:
      - 0-3 months total: Use "Weeks" (e.g., ["W1 2026", "W2 2026"])
      - 4-12 months total: Use "Months" (e.g., ["Jan 2026", "Feb 2026"])
      - 1-3 years total: Use "Quarters" (e.g., ["Q1 2026", "Q2 2026"])
      - 3+ years total: You MUST use "Years" (e.g., ["2020", "2021", "2022"])
  3.  **CHART DATA:** Create the 'data' array.
      - First, identify all logical swimlanes (e.g., "Regulatory Drivers", "JPMorgan Chase"). Add an object for each: \`{ "title": "Swimlane Name", "isSwimlane": true, "entity": "Swimlane Name" }\`
      - Immediately after each swimlane, add all tasks that belong to it: \`{ "title": "Task Name", "isSwimlane": false, "entity": "Swimlane Name", "bar": { ... } }\`
      - **DO NOT** create empty swimlanes. If you find no tasks for an entity, do not include it.
  4.  **BAR LOGIC:**
      - 'startCol' is the 1-based index of the 'timeColumns' array where the task begins.
      - 'endCol' is the 1-based index of the 'timeColumns' array where the task ends, **PLUS ONE**.
      - A task in "2022" has \`startCol: 3, endCol: 4\` (if 2020 is col 1).
      - If a date is "Q1 2024" and the interval is "Years", "2024" is the column. Map it to the "2024" column index.
      - If a date is unknown ("null"), the 'bar' object must be \`{ "startCol": null, "endCol": null, "color": "..." }\`.
  5.  **COLORS:** Assign colors logically ("blue", "ochre", "orange", "green", "default").
  6.  **SANITIZATION:** All string values MUST be valid JSON strings. You MUST properly escape any characters that would break JSON, such as double quotes (\") and newlines (\\n), within the string value itself.`;
  
  const geminiUserQuery = `User Prompt: "${userPrompt}"\n\nResearch Content:\n${researchTextCache}`;

  // 3. Define the schema for the *visual data only*
  const ganttSchema = {
    type: "OBJECT",
    properties: {
      title: { type: "STRING" },
      timeColumns: {
        type: "ARRAY",
        items: { type: "STRING" }
      },
      data: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            title: { type: "STRING" },
            isSwimlane: { type: "BOOLEAN" },
            entity: { type: "STRING" }, 
            bar: {
              type: "OBJECT",
              properties: {
                startCol: { type: "NUMBER" },
                endCol: { type: "NUMBER" },
                color: { type: "STRING" }
              },
            }
          },
          required: ["title", "isSwimlane", "entity"]
        }
      }
    },
    required: ["title", "timeColumns", "data"]
  };

  // 4. Define the payload
  const payload = {
    contents: [{ parts: [{ text: geminiUserQuery }] }],
    systemInstruction: { parts: [{ text: geminiSystemPrompt }] },
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: ganttSchema,
      maxOutputTokens: 8192,
      temperature: 0,
      topP: 1,
      topK: 1
    }
  };

  // 5. Call the API
  try {
    // This is line 180 (where the callGemini function is invoked)
    const ganttData = await callGemini(payload);
    
    // 6. Send the Gantt data to the frontend
    res.json(ganttData); // Send the object directly

  } catch (e) {
    console.error("API call error:", e);
    res.status(500).json({ error: `Error generating chart data: ${e.message}` });
  }
});


// -------------------------------------------------------------------
// --- "ON-DEMAND" ANALYSIS ENDPOINT (Unchanged) ---
// -------------------------------------------------------------------
app.post('/get-task-analysis', async (req, res) => {
  const { taskName, entity } = req.body;

  if (!taskName || !entity) {
    return res.status(400).json({ error: "Missing taskName or entity" });
  }

  // 1. Define the "Analyst" prompt
  const geminiSystemPrompt = `You are a senior project management analyst. Your job is to analyze the provided research and a user prompt to build a detailed analysis for *one single task*.

  You MUST respond with *only* a valid JSON object matching the 'analysisSchema'.
  
  **CRITICAL RULES FOR ANALYSIS:**
  1.  **NO INFERENCE:** For 'taskName', 'facts', and 'assumptions', you MUST use key phrases and data extracted *directly* from the provided text.
  2.  **CITE SOURCES:** For every 'fact' and 'assumption', you MUST cite the 'source' (e.g., "FileA.docx", "User Prompt").
  3.  **DETERMINE STATUS:** Determine the task's 'status' ("completed", "in-progress", or "not-started") based on the current date (assume "November 2025") and the task's dates.
  4.  **PROVIDE RATIONALE:** You MUST provide a 'rationale' for 'in-progress' and 'not-started' tasks, analyzing the likelihood of on-time completion based on the 'facts' and 'assumptions'.
  5.  **CLEAN STRINGS:** All string values MUST be valid JSON strings. You MUST properly escape any characters that would break JSON, such as double quotes (\") and newlines (\\n).`;
  
  const geminiUserQuery = `Research Content:\n${researchTextCache}\n\n**YOUR TASK:** Provide a full, detailed analysis for this specific task:
  - Entity: "${entity}"
  - Task Name: "${taskName}"`;

  // 2. Define the *single-task* schema
  const analysisSchema = {
    type: "OBJECT",
    properties: {
      taskName: { type: "STRING" },
      startDate: { type: "STRING" },
      endDate: { type: "STRING" },
      status: { type: "STRING", enum: ["completed", "in-progress", "not-started", "n/a"] },
      facts: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: { fact: { type: "STRING" }, source: { type: "STRING" } }
        }
      },
      assumptions: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: { assumption: { type: "STRING" }, source: { type: "STRING" } }
        }
      },
      rationale: { type: "STRING" }, // For 'in-progress' or 'not-started'
      summary: { type: "STRING" } // For 'completed'
    },
    required: ["taskName", "status"]
  };
  
  // 3. Define the payload
  const payload = {
    contents: [{ parts: [{ text: geminiUserQuery }] }],
    systemInstruction: { parts: [{ text: geminiSystemPrompt }] },
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: analysisSchema,
      maxOutputTokens: 4096, // Plenty for a single task
      temperature: 0,
      topP: 1,
      topK: 1
    }
  };

  // 4. Call the API
  try {
    const analysisData = await callGemini(payload);
    res.json(analysisData); // Send the single-task analysis back
  } catch (e) {
    console.error("Task Analysis API error:", e);
    res.status(500).json({ error: `Error generating task analysis: ${e.message}` });
  }
});

// --- Server Start ---
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});