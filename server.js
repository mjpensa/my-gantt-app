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

  // 1. Extract text from uploaded files
  try {
    if (req.files) {
      //
      // --- FIX FOR DETERMINISM (Part 1) ---
      // Sort files by name to ensure identical input order every time.
      //
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

  // 2. Build the prompt for the Gemini API
  //
  // <-- UPDATED PROMPT: Stricter rules for time logic.
  //
  const geminiSystemPrompt = `You are an expert project management analyst. Your job is to analyze a user's prompt and research files to build a Gantt chart.
  
  First, write a brief summary of your analysis (your thought process).
  
  Then, on a new line, provide the final JSON data block enclosed in triple backticks (\`\`\`json ... \`\`\`).
  
  **CRITICAL RULES FOR TIME LOGIC (MUST FOLLOW):**
  1.  First, analyze the *entire* set of tasks to find the earliest start date and latest end date.
  2.  Calculate the **Total Duration** of the project.
  3.  Based on this *Total Duration*, you MUST select *one* interval type. **DO NOT** mix intervals.
      * **< 3 Months:** Use "Weeks" (e.g., ["W1", "W2"])
      * **3 Months to 1 Year:** Use "Months" (e.g., ["Jan 2026", "Feb 2026"])
      * **1 Year to 3 Years:** Use "Quarters" (e.g., ["Q1 2026", "Q2 2026"])
      * **3+ Years:** Use "Years" (e.g., ["2026", "2027", "2028"])
  
  **CRITICAL RULES FOR JSON OUTPUT:**
  1.  **DATA ONLY:** The JSON fields are for *data only*. **DO NOT** add any notes or commentary *inside* the JSON.
  2.  **NO INFERENCE:** For all 'title' fields, you MUST use an existing heading, sub-heading, or key phrase directly from the provided text.
  3.  **MAXIMIZE DETAIL:** You MUST include *all* distinct tasks found in the research, even minor ones (e.g., pilots, testing).
  4.  **CLEAN STRINGS:** All string values MUST be sanitized. Remove all newlines (\\n), tabs (\\t), and double quotes (") from the text. Replace them with a single space.
  5.  **MANDATORY BAR OBJECT:** If 'isSwimlane' is false, the 'bar' object MUST be included. If no dates are found, set 'startCol' and 'endCol' to 'null'.
  
  **BAR LOGIC:**
  - 'startCol' is the 1-based index of the column (from 'timeColumns') where the task begins.
  - 'endCol' is the 1-based index of the column where the task ends, PLUS ONE.
  - If no dates are found, set 'startCol' and 'endCol' to 'null'.
  - Assign colors logically ("blue", "ochre", "orange", "green").`;
  
  const geminiUserQuery = `User Prompt: "${userPrompt}"\n\nResearch Content:\n${researchText}`;
  
  // 3. Define the payload
  const payload = {
    contents: [{ parts: [{ text: geminiUserQuery }] }],
    systemInstruction: { parts: [{ text: geminiSystemPrompt }] },
    generationConfig: {
      maxOutputTokens: 8192,
      //
      // --- FIX FOR DETERMINISM (Part 2) ---
      // Set temperature to 0 for 100% consistent outputs.
      //
      temperature: 0
    }
  };

  // 4. Call the Gemini API
  try {
    let ganttData = null;
    let lastError = null;
    
    // Retry up to 3 times
    for (let attempt = 0; attempt < 3; attempt++) {
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
        
        const fullResponseText = result.candidates[0].content.parts[0].text;
        
        // 1. Extract the JSON block using a regular expression
        const jsonMatch = fullResponseText.match(/```json\n([\s\S]*?)\n```/);
        
        if (!jsonMatch || !jsonMatch[1]) {
          console.error("Could not find JSON block in AI response:", fullResponseText);
          throw new Error("AI failed to provide a valid JSON data block.");
        }
        
        const extractedJsonText = jsonMatch[1];
        
        // 2. Parse the extracted text
        ganttData = JSON.parse(extractedJsonText);
        
        // If we got here, parsing succeeded
        break;
        
      } catch (parseError) {
        lastError = parseError;
        console.log(`Attempt ${attempt + 1} failed:`, parseError.message);
        if (attempt < 2) {
          await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        }
      }
    }
    
    if (!ganttData) {
      throw lastError || new Error('Failed to generate chart after 3 attempts');
    }
    
    // Validate ganttData structure
    if (!ganttData.timeColumns || !ganttData.data) {
      console.error('Invalid gantt data structure:', ganttData);
      throw new Error('AI returned incomplete chart data');
    }
    
    // 5. Send the pure JSON data back to the frontend
    res.json(ganttData);

  } catch (e) {
    console.error("API call error:", e);
    res.status(500).json({ error: `Error generating chart data: ${e.message}` });
  }
});

// --- Start Server ---
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});