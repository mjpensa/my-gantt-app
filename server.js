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
app.use(express.static(join(__dirname, 'Public'))); // Serve our HTML, CSS, JS
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
}

// --- "MAPREDUCE" ARCHITECTURE: "MAP" STEP (AI) ---
// This is the main endpoint for the *initial chart load*.
// It only fetches the *minimum* data (task names and dates).
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

  // 2. Define the swimlanes (our deterministic structure)
  const swimlaneDefinitions = [
    { entityName: "Regulatory Drivers", color: "orange" },
    { entityName: "Industry Standards Development", color: "green" },
    { entityName: "JPMorgan Chase", color: "blue" },
    { entityName: "Bank of America", color: "blue" },
    { entityName: "Citigroup", color: "blue" },
    { entityName: "Goldman Sachs", color: "blue" }
  ];

  let allTasks = [];
  let projectTitle = "Project Roadmap"; // Default

  try {
    // 3. Loop through each swimlane and make a *small* API call
    for (const swimlane of swimlaneDefinitions) {
      const { entityName, color } = swimlane;
      console.log(`--- Analyzing (light): ${entityName} ---`);

      // 4. Define the *lightweight* prompt and schema
      const geminiSystemPrompt = `You are a data extraction bot. Your job is to analyze the research and find all tasks for a *specific entity*.
      
      You MUST respond with *only* a valid JSON object matching the schema.
      
      **CRITICAL RULES:**
      1.  **NO ANALYSIS:** Do not provide facts, assumptions, or rationale.
      2.  **EXTRACT DATES:** Find the 'startDate' and 'endDate' (e.g., "2024", "Q1 2025", "null").
      3.  **CLEAN STRINGS:** All string values MUST be sanitized (no newlines, tabs, or double quotes).
      4.  **MAXIMIZE DETAIL:** Include all distinct tasks (pilots, testing, etc.) for this entity.
      5.  **PROJECT TITLE:** Extract the main project title from the user prompt or research.`;

      const geminiUserQuery = `User Prompt: "${userPrompt}"\n\nResearch Content:\n${researchTextCache}\n\n**YOUR TASK:** Extract the project title and all tasks (with dates) for the entity: "${entityName}"`;

      const lightSchema = {
        type: "OBJECT",
        properties: {
          projectTitle: { type: "STRING" },
          tasks: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                taskName: { type: "STRING" },
                startDate: { type: "STRING" },
                endDate: { type: "STRING" }
              },
              required: ["taskName"]
            }
          }
        },
        required: ["projectTitle", "tasks"]
      };

      // 5. Define the payload
      const payload = {
        contents: [{ parts: [{ text: geminiUserQuery }] }],
        systemInstruction: { parts: [{ text: geminiSystemPrompt }] },
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: lightSchema,
          maxOutputTokens: 8192, // This is fine, output will be small
          temperature: 0,
          topP: 1,
          topK: 1
        }
      };

      // 6. Call the API (no retry, it's inside a larger loop)
      const partialData = await callGemini(payload);

      // 7. "Reduce" Step: Collect the tasks
      for (const task of partialData.tasks) {
        allTasks.push({
          ...task,
          entity: entityName,
          color: color,
          isSwimlane: false
        });
      }
      projectTitle = partialData.projectTitle; // Use the latest title
    } // End of swimlane loop

    // 8. "Builder" Step: Server builds the final Gantt data
    const ganttData = buildGanttData(allTasks, swimlaneDefinitions, projectTitle);
    
    // 9. Send *only* the Gantt data to the frontend
    res.json({
      ganttData: ganttData
      // We are *not* sending analysisTableData anymore
    });

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
 * Builds the final Gantt chart data from the collected tasks.
 */
function buildGanttData(allTasks, swimlaneDefinitions, projectTitle) {
  
  // 1. Determine Time Scale (Deterministically)
  let allDates = [];
  allTasks.forEach(task => {
    if (task.startDate) allDates.push(parseDate(task.startDate));
    if (task.endDate) allDates.push(parseDate(task.endDate));
  });
  
  const validDates = allDates.filter(Boolean);
  // Handle case with no valid dates
  if (validDates.length === 0) {
    // Default to a 1-year, 4-quarter chart
    const startYear = new Date().getFullYear();
    return {
      title: projectTitle,
      timeColumns: [`Q1 ${startYear}`, `Q2 ${startYear}`, `Q3 ${startYear}`, `Q4 ${startYear}`],
      data: []
    };
  }
  
  const minDate = new Date(Math.min.apply(null, validDates));
  const maxDate = new Date(Math.max.apply(null, validDates));
  
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
    // Align to start of quarter
    d.setMonth(Math.floor(d.getMonth() / 3) * 3);
    while(d <= maxDate) {
      timeColumns.push(`Q${Math.floor(d.getMonth() / 3) + 1} ${d.getFullYear()}`);
      d.setMonth(d.getMonth() + 3);
    }
  } else {
    intervalType = "Years";
    const startYear = minDate.getFullYear() || new Date().getFullYear();
    const endYear = maxDate.getFullYear() || startYear + 1;
    for(let y = startYear; y <= endYear; y++) timeColumns.push(y.toString());
  }
  
  // 2. Build the Final 'ganttData'
  const ganttDataRows = [];
  
  for (const swimlane of swimlaneDefinitions) {
    ganttDataRows.push({
      title: swimlane.entityName,
      isSwimlane: true
    });
    
    const tasksForThisSwimlane = allTasks.filter(
      task => !task.isSwimlane && task.entity === swimlane.entityName
    );
    
    for (const task of tasksForThisSwimlane) {
      const bar = mapDatesToColumns(task.startDate, task.endDate, timeColumns, intervalType, task.color);
      
      ganttDataRows.push({
        title: task.taskName,
        isSwimlane: false,
        bar: bar,
        // Add entity to the data row for the frontend
        entity: task.entity 
      });
    }
  }

  // 3. Return the Gantt data object
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
  // Try parsing month-year
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
    if (isDateInColumn(startDate, timeColumns[i], intervalType)) {
      startCol = i + 1; // 1-based index
      break;
    }
  }

  const effectiveEndDate = endDate || timeColumns[timeColumns.length - 1];
  
  for(let i=0; i < timeColumns.length; i++) {
    if (isDateInColumn(effectiveEndDate, timeColumns[i], intervalType)) {
      endCol = i + 2; // 1-based index + 1 (for exclusive end)
    }
  }
  
  if (startCol && !endCol) {
    // If it started but didn't end, it must run off the chart
    endCol = timeColumns.length + 1;
  }
  
  if (startCol && !endCol && startDate === effectiveEndDate) {
    endCol = startCol + 1;
  }
  
  if (startCol === null) {
     return { startCol: null, endCol: null, color: color };
  }

  return { startCol, endCol, color };
}

/**
 * Helper function to check if a date string falls within a column.
 */
function isDateInColumn(dateStr, colName, intervalType) {
  if (!dateStr || !colName) return false;
  
  const parsedDate = parseDate(dateStr);
  if (!parsedDate) return false;
  
  const colDate = parseDate(colName);
  if (!colDate) return false;
  
  if (intervalType === "Years") {
    return parsedDate.getFullYear() === colDate.getFullYear();
  }
  if (intervalType === "Quarters") {
    const dYear = parsedDate.getFullYear();
    const cYear = colDate.getFullYear();
    const dQuarter = Math.floor(parsedDate.getMonth() / 3);
    const cQuarter = Math.floor(colDate.getMonth() / 3);
    
    // Handle "2024" matching "Q1 2024"
    if (dateStr.match(/^\d{4}$/)) {
      return dYear === cYear;
    }
    // Handle "Q1 2024" matching "Q1 2024"
    return dYear === cYear && dQuarter === cQuarter;
  }
  if (intervalType === "Months") {
    return parsedDate.getFullYear() === colDate.getFullYear() &&
           parsedDate.getMonth() === colDate.getMonth();
  }
  
  return false; // Default for Weeks or unknown
}

// --- THIS IS THE MISSING PIECE ---
// This line actually starts the server.
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});