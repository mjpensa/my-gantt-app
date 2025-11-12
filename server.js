<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <!-- THIS IS THE LINE THAT FIXES THE WARNING -->
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Dynamic Gantt Chart</title>
    <link rel="stylesheet" href="/style.css" />
    <script 
      src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js" 
      xintegrity="sha512-BNaRQnYJYiPSqHHDb58B0yaPfCu+cHio/BJLMBKSnQYjDRMvMMlPzgw6D/LIIXbaK3ddhiNRVbcC+WfcD+WjGg==" 
      crossorigin="anonymous" 
      referrerpolicy="no-referrer"
    ></script>
  </head>
  <body>

    <div class="app-container">
      <h1 class="app-title">Dynamic Gantt Chart Generator</h1>
      
      <!-- Input Form -->
      <form id="gantt-form" class="gantt-form">
        <div class="form-group">
          <label for="prompt-input">Prompt</label>
          <textarea id="prompt-input" rows="3" placeholder="e.g., Create a 2-year project plan for our 'Phoenix' app launch. The project must start in Q1 2026."></textarea>
        </div>
        <div class="form-group">
          <label for="file-input">Research Files (.md, .txt, .docx)</label>
          <input type="file" id="file-input" multiple accept=".md, .txt, .docx, application/vnd.openxmlformats-officedocument.wordprocessingml.document">
        </div>
        <div class="form-actions">
          <button type="submit" id="generate-btn" class="generate-button">Generate Chart</button>
          <div id="loading-indicator" class="loading-indicator" style="display: none;">
            <div class="spinner"></div>
            <span>Analyzing...</span>
          </div>
        </div>
      </form>

      <!-- Error Message Box -->
      <div id="error-message" class="error-message" style="display: none;"></div>

      <!-- Chart will be rendered here -->
      <div id="chart-output">
        <!-- This is a placeholder. main.js will fill it. -->
      </div>
    </div>

    <script type="module" src="/main.js"></script>
    
  </body>
</html>