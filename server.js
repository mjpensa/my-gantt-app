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

// --- API Endpoint for Chart Generation ---
app.post('/generate-chart', upload.array('researchFiles'), async (req, res) => {
  const userPrompt = req.body.prompt;
  let researchText = "";

  // 1. Extract text from uploaded files (Sort for determinism)
  try {
    if (req.files) {
      // Sort files by name to ensure consistent researchText input
      const sortedFiles = req.files.sort((a, b) => a.originalname.localeCompare(b.originalname));
      for (const file of sortedFiles) {
        researchText += `\n\n--- Start of file: ${file.originalname} ---\n`;
        if (file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
          const result = await mammoth.extractRawText({ buffer: file.buffer });
          researchText += result.value;
        } else {
          researchText += file.buffer.toString('utf8');
        }
        researchText += `\n--- End of file: ${file.originalname} ---\n`;
      }
    }
  } catch (e) {
    console.error("File extraction error:", e);
    return res.status(500).json({ error: "Error processing uploaded files." });
  }

  // 2. --- "MAPREDUCE" ARCHITECTURE: "MAP" STEP (AI) ---
  // We make multiple small, simple API calls instead of one large, complex one.

  // This is our deterministic structure. The AI will fill in the tasks for each.
  const swimlaneDefinitions = [
    { entityName: "Regulatory Drivers", color: "orange" }, // Using 'orange' for 'red'
    { entityName: "Industry Standards Development", color: "green" },
    { entityName: "JPMorgan Chase", color: "blue" },
    { entityName: "Bank of America", color: "blue" },
    { entityName: "Citigroup", color: "blue" },
    { entityName: "Goldman Sachs", color: "blue" }
  ];

  let allTasks = []; // We will collect all tasks from all AI calls here
  let projectTitle = "Project Roadmap"; // Default title

  try {
    for (const swimlane of swimlaneDefinitions) {
      const { entityName, color } = swimlane;
      
      console.log(`--- Analyzing entity: ${entityName} ---`);

      // 3. Build the "Map" prompt for the Gemini API
      const geminiSystemPrompt = `You are a data extraction bot. Your job is to analyze a user's prompt and research files to extract a detailed "AnalysisSheet" *only* for a specific entity.
      
      You MUST respond with *only* a valid JSON object matching the 'analysisSheetSchema'.
      
      **CRITICAL RULES FOR ANALYSIS:**
      1.  **NO INFERENCE:** For 'taskName', 'facts', and 'assumptions', you MUST use key phrases and data extracted *directly* from the provided text.
      2.  **CITE SOURCES:** For every 'fact' and 'assumption', you MUST cite the 'source' (e.g., "FileA.docx", "User Prompt").
      3.  **DETERMINE STATUS:** For each task, you must determine its 'status' ("completed", "in-progress", or "not-started") based on the current date and the task's dates.
      4.  **PROVIDE RATIONALE:** You MUST provide a 'rationale' for 'in-progress' and 'not-started' tasks, analyzing the likelihood of on-time completion based on the 'facts' and 'assumptions'.
      5.  **CLEAN STRINGS:** All string values MUST be sanitized. Remove all newlines (\\n), tabs (\\t), and double quotes (") from the text.
      6.  **MAXIMIZE DETAIL:** You MUST include *all* distinct tasks found in the research (pilots, testing, etc.) that match the target entity.
      
      **DATE LOGIC:**
      - 'startDate' and 'endDate' MUST be a year (e.g., "2024") or quarter (e.g., "Q1 2025") from the text.
      - If a date is unknown, use "null".
      - If a task is ongoing, set 'endDate' to the end of the project's timeframe (e.g., "2030").`;

      const geminiUserQuery = `User Prompt: "${userPrompt}"\n\nResearch Content:\n${researchText}\n\n**YOUR TASK:** Extract all tasks, facts, and analysis for the entity: "${entityName}"`;

      // 4. Define the strict JSON output schema
      const analysisSheetSchema = {
        type: "OBJECT",
        properties: {
          // We ask for the project title in each call; we'll use the last one
          projectTitle: { type: "STRING" }, 
          tasks: {
            type: "ARRAY",
            items: {
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
                rationale: { type: "STRING" },
                summary: { type: "STRING" }
              },
              required: ["taskName", "status"]
            }
          }
        },
        required: ["projectTitle", "tasks"]
      };

      // 5. Define the payload for this single "Map" call
      const payload = {
        contents: [{ parts: [{ text: geminiUserQuery }] }],
        systemInstruction: { parts: [{ text: geminiSystemPrompt }] },
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: analysisSheetSchema,
          maxOutputTokens: 8192, // 8k is fine for this smaller, scoped task
          temperature: 0,
          topP: 1,
          topK: 1
        }
      };

      // 6. Call the Gemini API (with retry)
      let partialAnalysisSheet = null;
      let lastError = null;

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`API call failed for ${entityName} with status: ${response.status} - ${errorText}`);
          }
          const result = await response.json();
          if (!result.candidates || !result.candidates[0] || !result.candidates[0].content) {
            throw new Error(`Invalid response from AI API for ${entityName}`);
          }
          const extractedJsonText = result.candidates[0].content.parts[0].text;
          partialAnalysisSheet = JSON.parse(extractedJsonText);
          break; // Success
        } catch (parseError) {
          lastError = parseError;
          console.log(`Attempt ${attempt + 1} failed for ${entityName}:`, parseError.message);
          if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        }
      }
      
      if (!partialAnalysisSheet) {
        throw lastError || new Error(`AI failed to extract data for ${entityName} after 3 attempts`);
      }

      // 7. --- "REDUCE" STEP (Collect tasks) ---
      // Add the entity and color back into the tasks
      for (const task of partialAnalysisSheet.tasks) {
        allTasks.push({
          ...task,
          entity: entityName, // Add the entity
          color: color,       // Add the color
          isSwimlane: false   // Mark as a task
        });
      }
      projectTitle = partialAnalysisSheet.projectTitle; // Update title
    } // End of swimlane loop

    // 8. --- "BUILDER" LOGIC (STEP 2) ---
    // Now we (the server) build the final data objects deterministically
    //
    const { ganttData, analysisTableData } = buildFrontendData(allTasks, swimlaneDefinitions, projectTitle);
    
    // 9. Send *both* data objects back to the frontend
    res.json({
      ganttData: ganttData,
      analysisTableData: analysisTableData
    });

  } catch (e) {
    console.error("API call error:", e);
    res.status(500).json({ error: `Error generating chart data: ${e.message}` });
  }
});

// --- Start Server ---
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});


// -------------------------------------------------------------------
// --- STEP 2: "BUILDER" LOGIC (100% Deterministic) ---
// -------------------------------------------------------------------

/**
 * Builds the final Gantt chart and Analysis table data
 * from the AI's "AnalysisSheet".
 */
function buildFrontendData(allTasks, swimlaneDefinitions, projectTitle) {
  
  // --- 1. Determine Time Scale (Deterministically) ---
  let allDates = [];
  allTasks.forEach(task => {
    if (task.startDate) allDates.push(parseDate(task.startDate));
    if (task.endDate) allDates.push(parseDate(task.endDate));
  });
  
  const minDate = new Date(Math.min.apply(null, allDates.filter(Boolean)));
  const maxDate = new Date(Math.max.apply(null, allDates.filter(Boolean)));
  
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
  
  // --- 2. Build the Final 'ganttData' and 'analysisTableData' Arrays ---
  const ganttDataRows = [];
  const analysisTableRows = [];
  
  for (const swimlane of swimlaneDefinitions) {
    // 1. Add the swimlane header to the Gantt data
    ganttDataRows.push({
      title: swimlane.entityName,
      isSwimlane: true
    });
    
    // 2. Find all facts (tasks) for this swimlane
    const tasksForThisSwimlane = allTasks.filter(
      task => !task.isSwimlane && task.entity === swimlane.entityName
    );
    
    // 3. Add all tasks
    for (const task of tasksForThisSwimlane) {
      const bar = mapDatesToColumns(task.startDate, task.endDate, timeColumns, intervalType, task.color);
      
      // Add to Gantt Data
      ganttDataRows.push({
        title: task.taskName,
        isSwimlane: false,
        bar: bar
      });
      
      // Add to Analysis Table Data
      analysisTableRows.push({
        taskName: task.taskName,
        startDate: task.startDate || "N/A",
        endDate: task.endDate || "N/A",
        status: task.status || "n/a",
        facts: task.facts || [],
        assumptions: task.assumptions || [],
        rationale: task.rationale || "N/A",
        summary: task.summary || "N/A"
      });
    }
  }

  // 4. Return both objects
  return {
    ganttData: {
      title: projectTitle,
      timeColumns: timeColumns,
      data: ganttDataRows
    },
    analysisTableData: analysisTableRows
  };
}

/**
 * Helper function to parse a date string (e.g., "Q1 2024" or "2024")
 * into a Date object for comparison.
 */
function parseDate(dateStr) {
  if (!dateStr || dateStr === "null") return null;
  
  if (dateStr.match(/^Q\d \d{4}$/)) { // "Q1 2024"
    const [quarter, year] = dateStr.split(' ');
    const month = (parseInt(quarter.substring(1)) - 1) * 3; // Q1 -> 0, Q2 -> 3, etc.
    return new Date(year, month);
  }
  if (dateStr.match(/^\d{4}$/)) { // "2024"
    return new Date(dateStr, 0, 1); // Jan 1st of that year
  }
  // Add more parsers if needed (e.g., for "Jan 2024")
  return new Date(dateStr); // Fallback
}

/**
 * Helper function to deterministically map dates to column numbers.
 */
function mapDatesToColumns(startDate, endDate, timeColumns, intervalType, color) {
  if (!startDate || startDate === "null") {
    return { startCol: null, endCol: null, color: color };
  }

  let startCol = null;
  let endCol = null;
  
  // Find startCol
  for(let i=0; i < timeColumns.length; i++) {
    if (isDateInColumn(startDate, timeColumns[i], intervalType)) {
      startCol = i + 1; // 1-based index
      break;
    }
  }

  // Find endCol
  const effectiveEndDate = endDate || timeColumns[timeColumns.length - 1]; // Default to end of chart
  
  for(let i=0; i < timeColumns.length; i++) {
    if (isDateInColumn(effectiveEndDate, timeColumns[i], intervalType)) {
      endCol = i + 2; // 1-based index + 1 (for exclusive end)
    }
  }
  
  // Fallback for ongoing tasks that go off the chart
  if (startCol && !endCol) {
    endCol = timeColumns.length + 1;
  }
  
  // Handle tasks that are just a single point in time (e.g., in "2024")
  if (startCol && !endCol && startDate === effectiveEndDate) {
    endCol = startCol + 1;
  }
  
  // Re-check for "UNKNOWN" / null
  if (startCol === null) {
     return { startCol: null, endCol: null, color: color };
  }

  return { startCol, endCol, color };
}

/**
 * Helper function to check if a date string (e.g., "Q1 2024" or "2024")
 * falls within a given column (e.g., "2024").
 */
function isDateInColumn(dateStr, colName, intervalType) {
  if (!dateStr || !colName) return false;
  
  const dateYearMatch = dateStr.match(/\d{4}/);
  if (!dateYearMatch) return false;
  const year = dateYearMatch[0];
  
  if (intervalType === "Years") {
    return dateStr.includes(colName);
  }
  if (intervalType === "Quarters") {
    const colYear = colName.split(' ')[1];
    const colQuarter = colName.split(' ')[0]; // "Q1"
    
    const dateQuarterMatch = dateStr.match(/Q(\d)/);
    if (dateQuarterMatch) {
      // It's a quarter string, e.g., "Q1 2024"
      return dateStr === colName;
    } else {
      // It's just a year string, e.g., "2024"
      // Does "2024" fall into "Q1 2024"? Yes.
      return year === colYear;
    }
  }
  // Add more logic for Months/Weeks if needed
  return dateStr.includes(colName);
}