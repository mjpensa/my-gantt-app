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
// Use 'Public' (uppercase) to match your folder structure
app.use(express.static(join(__dirname, 'Public'))); 
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

      // Check for safety ratings
      const safetyRatings = result.candidates[0].safetyRatings;
      if (safetyRatings) {
        const blockedRating = safetyRatings.find(rating => rating.blocked);
        if (blockedRating) {
          throw new Error(`API call blocked due to safety rating: ${blockedRating.category}`);
        }
      }
      
      const extractedJsonText = result.candidates[0].content.parts[0].text;
      return JSON.parse(extractedJsonText); // Return the parsed JSON

    } catch (error) {
      console.log(`Attempt ${attempt + 1} failed:`, error.message);
      if (attempt >= retryCount - 1) {
        throw error; // Throw the last error
      }
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  // This line should not be reachable if all retries fail, as the error is thrown.
  throw new Error('All API retry attempts failed.');
}


// --- "MAPREDUCE" ARCHITECTURE IS NOW A "FACT-CHECKER" ARCHITECTURE ---

// --- STEP 1 (AI): Extract a simple "Fact Sheet" ---
async function extractFactSheet(userPrompt, researchText) {
  console.log("--- Calling AI: Extracting Fact Sheet ---");

  // The AI's *only* job is to extract facts. It does *not* build the chart.
  const factExtractionPrompt = `You are a data-extraction bot. Your job is to read the user's prompt and research files and extract every single project task, its parent entity (e.g., bank, regulatory body), and its start/end dates.
  
  You MUST respond with *only* a JSON object matching the schema.
  
  **CRITICAL RULES:**
  1.  **DO NOT** make any decisions about swimlanes or chart structure.
  2.  Extract *every* task, even minor ones (pilots, testing).
  3.  'taskName' MUST be a concise summary (under 100 chars) of the task, using keywords from the text.
  4.  'entity' MUST be the parent organization (e.g., "JPMorgan Chase", "Bank of America", "Citigroup", "Regulatory Drivers", "Industry Standards Development", "Goldman Sachs").
  5.  'startDate' and 'endDate' MUST be a year (e.g., "2024") or quarter (e.g., "Q1 2025") from the text.
  6.  If a date is unknown, use "null". If a task is ongoing, set 'endDate' to the end of the project's timeframe (e.g., "2030").
  7.  Sanitize all strings: remove newlines, tabs, and double quotes.
  8.  Extract the main project 'projectTitle' from the user prompt or research.`;

  const geminiUserQuery = `User Prompt: "${userPrompt}"\n\nResearch Content:\n${researchText}`;
  
  const factSchema = {
    type: "OBJECT",
    properties: {
      projectTitle: { type: "STRING" },
      tasks: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            taskName: { type: "STRING" },
            entity: { type: "STRING" },
            startDate: { type: "STRING" },
            endDate: { type: "STRING" }
          },
          required: ["taskName", "entity"]
        }
      }
    },
    required: ["projectTitle", "tasks"]
  };

  const payload = {
    contents: [{ parts: [{ text: geminiUserQuery }] }],
    systemInstruction: { parts: [{ text: factExtractionPrompt }] },
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: factSchema,
      maxOutputTokens: 8192,
      temperature: 0,
      topP: 1,
      topK: 1
    }
  };
  
  return await callGemini(payload);
}

// --- Main Endpoint ---
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

  try {
    // 2. --- STEP 1: Call AI to get the simple "Fact Sheet" ---
    const factSheet = await extractFactSheet(userPrompt, researchTextCache);
    
    // --- Also get the user's requested dates (a small, separate call) ---
    let requestedDates = { startDate: null, endDate: null };
    try {
      console.log("--- Analyzing User Prompt for Date Range ---");
      requestedDates = await getRequestedDates(userPrompt, researchTextCache);
    } catch (e) {
      console.error("Could not parse requested dates, falling back to earliest.");
    }
    
    // 3. --- STEP 2: Server builds the final Gantt data deterministically ---
    const ganttData = buildGanttData(factSheet, requestedDates);
    
    // 4. Send the Gantt data to the frontend
    res.json(ganttData);

  } catch (e) {
    console.error("API call error:", e);
    res.status(500).json({ error: `Error generating chart data: ${e.message}` });
  }
});


// -------------------------------------------------------------------
// --- NEW ENDPOINT: "ON-DEMAND" ANALYSIS ---
// -------------------------------------------------------------------
app.post('/get-task-analysis', async (req, res) => {
  const { taskName, entity } = req.body;

  if (!taskName || !entity) {
    return res.status(400).json({ error: "Missing taskName or entity" });
  }

  // 1. Define the "Analyst" prompt (from our previous design)
  const geminiSystemPrompt = `You are a senior project management analyst. Your job is to analyze the provided research and a user prompt to build a detailed analysis for *one single task*.

  You MUST respond with *only* a valid JSON object matching the 'analysisSchema'.
  
  **CRITICAL RULES FOR ANALYSIS:**
  1.  **NO INFERENCE:** For 'taskName', 'facts', and 'assumptions', you MUST use key phrases and data extracted *directly* from the provided text.
  2.  **CITE SOURCES:** For every 'fact' and 'assumption', you MUST cite the 'source' (e.g., "FileA.docx", "User Prompt").
  3.  **DETERMINE STATUS:** Determine the task's 'status' ("completed", "in-progress", or "not-started") based on the current date (assume "November 2025") and the task's dates.
  4.  **PROVIDE RATIONALE:** You MUST provide a 'rationale' for 'in-progress' and 'not-started' tasks, analyzing the likelihood of on-time completion based on the 'facts' and 'assumptions'.
  5.  **CLEAN STRINGS:** All string values MUST be sanitized (no newlines, tabs, or double quotes).`;
  
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


// -------------------------------------------------------------------
// --- "BUILDER" & HELPER FUNCTIONS (Deterministic) ---
// -------------------------------------------------------------------

/**
 * --- NEW: Helper to get the user's requested date range ---
 */
async function getRequestedDates(userPrompt, researchText) {
  const geminiSystemPrompt = `You are a date extraction bot. Analyze the user prompt and research. Extract the *explicitly requested* start and end date for the chart.
  If the user asks for a "10-year plan from 2020", you must return { "startDate": "2020", "endDate": "2030" }.
  If the user says "a 2-year project starting Q1 2026", return { "startDate": "Q1 2026", "endDate": "Q4 2027" }.
  If no explicit range is requested, return { "startDate": null, "endDate": null }.
  You must respond *only* with the JSON object.`;
  
  const geminiUserQuery = `User Prompt: "${userPrompt}"\n\nResearch Content:\n${researchText}`;

  const schema = {
    type: "OBJECT",
    properties: {
      startDate: { type: "STRING" },
      endDate: { type: "STRING" }
    },
    required: ["startDate", "endDate"]
  };
  
  const payload = {
    contents: [{ parts: [{ text: geminiUserQuery }] }],
    systemInstruction: { parts: [{ text: geminiSystemPrompt }] },
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: schema,
      temperature: 0,
      topP: 1,
      topK: 1
    }
  };
  
  // Use callGemini helper
  return await callGemini(payload, 1); // Only try once
}


/**
 * Builds the final Gantt chart data from the collected tasks.
 * --- NEW: Accepts requestedDates object ---
 */
function buildGanttData(factSheet, requestedDates) {
  
  // --- 1. Define the Deterministic Structure ---
  // This is our "contract." The structure is *always* this.
  const swimlaneDefinitions = [
    { entityName: "Regulatory Drivers", color: "orange" },
    { entityName: "Industry Standards Development", color: "green" },
    { entityName: "JPMorgan Chase", color: "blue" },
    { entityName: "Bank of America", color: "blue" },
    { entityName: "Citigroup", color: "blue" },
    { entityName: "Goldman Sachs", color: "blue" }
  ];
  
  const allTasks = factSheet.tasks || [];
  const projectTitle = factSheet.projectTitle || "Project Roadmap";
  
  // 2. Determine Time Scale (Deterministically)
  let allDates = [];
  allTasks.forEach(task => {
    if (task.startDate) allDates.push(parseDate(task.startDate));
    if (task.endDate) allDates.push(parseDate(task.endDate));
  });
  
  let validDates = allDates.filter(Boolean);
  
  // --- NEW LOGIC: Use requested dates if available ---
  let minDate, maxDate;
  
  if (requestedDates.startDate) {
    minDate = parseDate(requestedDates.startDate);
  } else if (validDates.length > 0) {
    minDate = new Date(Math.min.apply(null, validDates));
  } else {
    minDate = new Date(new Date().getFullYear(), 0, 1); // Default to Jan 1 this year
  }
  
  if (requestedDates.endDate) {
    maxDate = parseDate(requestedDates.endDate);
  } else if (validDates.length > 0) {
    maxDate = new Date(Math.max.apply(null, validDates));
  } else {
    maxDate = new Date(minDate.getFullYear() + 1, 0, 1); // Default to 1 year later
  }
  // ---

  // Handle case with no valid dates or reversed dates
  if (!minDate || !maxDate || minDate >= maxDate) {
    minDate = new Date(new Date().getFullYear(), 0, 1);
    maxDate = new Date(minDate.getFullYear() + 1, 11, 31);
  }
  
  const totalMonths = (maxDate.getFullYear() - minDate.getFullYear()) * 12 + (maxDate.getMonth() - minDate.getMonth());
  
  let timeColumns = [];
  let intervalType = "Years"; // Default
  
  if (totalMonths <= 3) {
    intervalType = "Weeks";
    const numWeeks = Math.ceil(totalMonths * 4.33) || 1;
    for(let i=1; i <= numWeeks; i++) timeColumns.push(`W${i}`);

  } else if (totalMonths <= 12) {
    intervalType = "Months";
    let d = new Date(minDate);
    while(d <= maxDate) {
      timeColumns.push(d.toLocaleString('default', { month: 'short' }) + ' ' + d.getFullYear());
      d.setMonth(d.getMonth() + 1);
    }

  } else if (totalMonths <= 36) {
    intervalType = "Quarters";
    let d = new Date(minDate);
    d.setMonth(Math.floor(d.getMonth() / 3) * 3); // Align to start of quarter
    while(d <= maxDate) {
      timeColumns.push(`Q${Math.floor(d.getMonth() / 3) + 1} ${d.getFullYear()}`);
      d.setMonth(d.getMonth() + 3);
    }
  } else {
    intervalType = "Years";
    const startYear = minDate.getFullYear();
    const endYear = maxDate.getFullYear();
    for(let y = startYear; y <= endYear; y++) timeColumns.push(y.toString());
  }
  
  // 3. Build the Final 'ganttData'
  const ganttDataRows = [];
  
  // --- NEW: Map entities to their colors for lookup ---
  const colorMap = new Map();
  for (const def of swimlaneDefinitions) {
    colorMap.set(def.entityName, def.color);
  }
  
  for (const swimlane of swimlaneDefinitions) {
    ganttDataRows.push({
      title: swimlane.entityName,
      isSwimlane: true
    });
    
    const tasksForThisSwimlane = allTasks.filter(
      task => task.entity === swimlane.entityName
    );
    
    for (const task of tasksForThisSwimlane) {
      const color = colorMap.get(task.entity) || "default";
      const bar = mapDatesToColumns(task.startDate, task.endDate, timeColumns, intervalType, color);
      
      // --- NEW: Only add tasks that are *within* the chart's time range ---
      if (bar.startCol !== null || bar.endCol !== null) {
        ganttDataRows.push({
          title: task.taskName,
          isSwimlane: false,
          bar: bar,
          entity: task.entity 
        });
      }
    }
  }

  // 4. Return the Gantt data object
  return {
    title: projectTitle,
    timeColumns: timeColumns,
    data: ganttDataRows
  };
}

/**
 * Helper function to parse a date string (e.g., "Q1 2024" or "2024")
 */
function parseDate(dateStr) {
  if (!dateStr || dateStr === "null") return null;
  
  if (dateStr.match(/^Q\d \d{4}$/)) { // "Q1 2024"
    const [quarter, year] = dateStr.split(' ');
    const month = (parseInt(quarter.substring(1)) - 1) * 3;
    return new Date(year, month);
  }
  if (dateStr.match(/^\d{4}$/)) { // "2024"
    return new Date(dateStr, 0, 1);
  }
  const monthYear = dateStr.match(/(\w{3}) (\d{4})/);
  if (monthYear) {
    try {
      return new Date(dateStr);
    } catch(e) { return null; }
  }
  
  return null; // Return null if format is unrecognized
}

/**
 * Helper function to map dates to column numbers.
 */
function mapDatesToColumns(startDate, endDate, timeColumns, intervalType, color) {
  if (!startDate || startDate === "null") {
    return { startCol: null, endCol: null, color: color };
  }

  let startCol = null;
  let endCol = null;
  
  for(let i=0; i < timeColumns.length; i++) {
    if (isDateInColumn(startDate, timeColumns[i], intervalType, "start")) {
      startCol = i + 1; // 1-based index
      break;
    }
  }

  // --- NEW: Use chart end date as a fallback ---
  const effectiveEndDate = endDate || timeColumns[timeColumns.length - 1];
  
  for(let i=0; i < timeColumns.length; i++) {
    if (isDateInColumn(effectiveEndDate, timeColumns[i], intervalType, "end")) {
      endCol = i + 2; // 1-based index + 1 (for exclusive end)
    }
  }
  
  if (startCol && !endCol) {
    // If it started, but didn't end (e.g., end date is "2030" but chart ends at "2026")
    // Clip it to the end of the chart
    endCol = timeColumns.length + 1;
  }
  
  if (startCol && !endCol && startDate === effectiveEndDate) {
    endCol = startCol + 1;
  }
  
  // --- NEW: Handle tasks that end before the chart starts or start after it ends ---
  if (startCol === null && endCol === null) {
    // Check if task is entirely outside the range
    const start = parseDate(startDate);
    const end = parseDate(effectiveEndDate);
    const chartStart = parseDate(timeColumns[0]);
    const chartEnd = parseDate(timeColumns[timeColumns.length - 1]);

    if (end && chartStart && end < chartStart) {
      return { startCol: null, endCol: null, color: color }; // Ends before chart
    }
    if (start && chartEnd && start > chartEnd) {
      return { startCol: null, endCol: null, color: color }; // Starts after chart
    }
  }
  
  // If it starts before the chart, clip it to the start
  if (startCol === null && endCol !== null) {
    startCol = 1;
  }

  return { startCol, endCol, color };
}

/**
 * Helper function to check if a date string falls within a column.
 */
function isDateInColumn(dateStr, colName, intervalType, dateType) {
  if (!dateStr || !colName) return false;
  
  const parsedDate = parseDate(dateStr);
  if (!parsedDate) return false;
  
  const colDate = parseDate(colName);
  if (!colDate) return false;

  const dYear = parsedDate.getFullYear();
  const cYear = colDate.getFullYear();
  
  if (intervalType === "Years") {
    return dYear === cYear;
  }
  
  const dMonth = parsedDate.getMonth();
  const cMonth = colDate.getMonth();

  if (intervalType === "Quarters") {
    const dQuarter = Math.floor(dMonth / 3);
    const cQuarter = Math.floor(cMonth / 3);
    
    // "2024" (as a start date) should match "Q1 2024"
    if (dateStr.match(/^\d{4}$/) && dateType === "start") {
      return dYear === cYear && cQuarter === 0;
    }
    // "2024" (as an end date) should match "Q4 2024"
    if (dateStr.match(/^\d{4}$/) && dateType === "end") {
      return dYear === cYear && cQuarter === 3;
    }
    // "Q1 2024" matching "Q1 2024"
    return dYear === cYear && dQuarter === cQuarter;
  }
  if (intervalType === "Months") {
    // "2024" (as a start date) should match "Jan 2024"
    if (dateStr.match(/^\d{4}$/) && dateType === "start") {
      return dYear === cYear && cMonth === 0;
    }
    // "2024" (as an end date) should match "Dec 2024"
    if (dateStr.match(/^\d{4}$/) && dateType === "end") {
      return dYear === cYear && cMonth === 11;
    }
    return dYear === cYear && dMonth === cMonth;
  }
  
  return false; // Default for Weeks or unknown
}

// --- THIS IS THE MISSING PIECE ---
// This line actually starts the server.
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});