import express from 'express';
import multer from 'multer';
import mammoth from 'mammoth';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import 'dotenv/config';

// --- Gemini API Configuration ---
// We will use the v1beta model for JSON schema support
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
      for (const file of req.files) {
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
  // <-- UPDATED PROMPT: Added "DATA ONLY" rule.
  //
  const geminiSystemPrompt = `You are an expert project management analyst. Your job is to analyze a user's prompt and research files to build a Gantt chart. You must respond ONLY with a valid JSON object matching the defined schema.
  
  **CRITICAL RULES FOR JSON OUTPUT:**
  1.  **DATA ONLY:** The JSON fields are for *data only*. **DO NOT** add any notes, commentary, summaries, or explanations (like "CRITICAL NOTE: ...") into the JSON data fields. The 'title' field should contain *only* the chart's title, and nothing else.
  2.  **NO INFERENCE:** For all 'title' fields, you MUST use an existing heading, sub-heading, or key phrase directly from the provided text. **Do not make up or infer your own summaries.**
  3.  **CONCISE TITLES:** If a heading or phrase is very long, shorten it, but stick to the original words. Keep all titles under 150 characters.
  4.  **CLEAN STRINGS:** All string values MUST be sanitized. Remove all newlines (\\n), tabs (\\t), and double quotes (") from the text. Replace them with a single space.
  
  **TIME LOGIC:**
  - 1-8 weeks: Use "Weeks" (e.g., ["W1", "W2"])
  - 2-12 months: Use "Months" (e.g., ["Jan 2026", "Feb 2026"])
  - 1-3 years: Use "Quarters" (e.g., ["Q1 2026", "Q2 2026"])
  - 3+ years: Use "Years" (e.g., ["2026", "2027"])
  
  **BAR LOGIC:**
  - 'startCol' is the 1-based index of the column where the task begins.
  - 'endCol' is the 1-based index of the column where the task ends, PLUS ONE. A task in "W1" has startCol: 1, endCol: 2. A task from "W1" to "W2" has startCol: 1, endCol: 3.
  - Assign colors logically ("blue", "ochre", "orange", "green").`;
  
  const geminiUserQuery = `User Prompt: "${userPrompt}"\n\nResearch Content:\n${researchText}`;
  
  // 3. Define the strict JSON output schema
  const schema = {
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
            bar: {
              type: "OBJECT",
              properties: {
                startCol: { type: "NUMBER" },
                endCol: { type: "NUMBER" },
                color: { type: "STRING" }
              }
            }
          }
        }
      }
    }
  };

  // 4. Call the Gemini API
  try {
    const payload = {
      contents: [{ parts: [{ text: geminiUserQuery }] }],
      systemInstruction: { parts: [{ text: geminiSystemPrompt }] },
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: schema,
        maxOutputTokens: 8192,
        temperature: 0.2
      }
    };

    let ganttData = null;
    let lastError = null;
    
    // Retry up to 3 times for JSON parsing errors
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
        
        // Check if API returned valid data
        if (!result.candidates || !result.candidates[0] || !result.candidates[0].content) {
          console.error('Invalid API response:', JSON.stringify(result));
          throw new Error('Invalid response from AI API');
        }
        
        const jsonText = result.candidates[0].content.parts[0].text;
        ganttData = JSON.parse(jsonText);
        
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
      throw new Error('AI returned incomplete chart data'); // This is the error you are seeing
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