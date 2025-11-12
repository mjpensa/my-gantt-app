/**
 * This is the main frontend script.
 * It handles form submission, API calls, and chart rendering.
 */

// --- Event Listeners ---
document.addEventListener("DOMContentLoaded", () => {
  const ganttForm = document.getElementById('gantt-form');
  ganttForm.addEventListener('submit', handleChartGenerate);
});

/**
 * Handles the "Generate Chart" button click
 */
async function handleChartGenerate(event) {
  event.preventDefault(); // Stop form from reloading page

  const generateBtn = document.getElementById('generate-btn');
  const loadingIndicator = document.getElementById('loading-indicator');
  const errorMessage = document.getElementById('error-message');
  const chartOutput = document.getElementById('chart-output');

  // 1. Get form data
  const promptInput = document.getElementById('prompt-input');
  const fileInput = document.getElementById('file-input');
  
  const formData = new FormData();
  formData.append('prompt', promptInput.value);
  for (const file of fileInput.files) {
    formData.append('researchFiles', file);
  }

  // 2. Update UI to show loading
  generateBtn.disabled = true;
  loadingIndicator.style.display = 'flex';
  errorMessage.style.display = 'none';
  chartOutput.innerHTML = ''; // Clear old chart

  try {
    // 3. Call the backend API
    const response = await fetch('/generate-chart', {
      method: 'POST',
      body: formData,
      // No 'Content-Type' header, browser sets it for FormData
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || `Server error: ${response.status}`);
    }

    // 4. Get the JSON data from the server
    const ganttData = await response.json();

    // 4.5. Validate the data structure
    if (!ganttData || !ganttData.timeColumns || !ganttData.data) {
      throw new Error('Invalid chart data received from server');
    }

    // 5. Render the chart
    setupChart(ganttData);

  } catch (error) {
    console.error("Error generating chart:", error);
    errorMessage.textContent = `Error: ${error.message}`;
    errorMessage.style.display = 'block';
  } finally {
    // 6. Restore UI
    generateBtn.disabled = false;
    loadingIndicator.style.display = 'none';
  }
}

/**
 * The Dynamic Renderer.
 * This function builds the chart *based on* the data from the server.
 */
function setupChart(ganttData) {
  
  const container = document.getElementById('chart-output');
  if (!container) {
    console.error("Could not find chart container!");
    return;
  }
  
  // Clear container
  container.innerHTML = '';

  // Create the main chart wrapper
  const chartWrapper = document.createElement('div');
  chartWrapper.id = 'gantt-chart-container'; // ID for styling & export

  // Add Title (from data)
  const titleEl = document.createElement('div');
  titleEl.className = 'gantt-title';
  titleEl.textContent = ganttData.title;
  chartWrapper.appendChild(titleEl);

  // Create Grid
  const gridEl = document.createElement('div');
  gridEl.className = 'gantt-grid';
  
  // --- Dynamic Grid Columns (Objective 1 & 4) ---
  const numCols = ganttData.timeColumns.length;
  // Set the CSS Grid layout dynamically
  gridEl.style.gridTemplateColumns = `minmax(220px, 1.5fr) repeat(${numCols}, 1fr)`;

  // --- Create Header Row (from data) ---
  // Add empty top-left cell
  const headerLabel = document.createElement('div');
  headerLabel.className = 'gantt-header gantt-header-label';
  gridEl.appendChild(headerLabel);
  
  // Add time column headers (from data)
  for (const colName of ganttData.timeColumns) {
    const headerCell = document.createElement('div');
    headerCell.className = 'gantt-header';
    headerCell.textContent = colName;
    gridEl.appendChild(headerCell);
  }

  // --- Create Data Rows (from data) (Objective 2 & 3) ---
  for (const row of ganttData.data) {
    const isSwimlane = row.isSwimlane;
    
    // 1. Create Label Cell
    const labelEl = document.createElement('div');
    labelEl.className = `gantt-row-label ${isSwimlane ? 'swimlane' : 'task'}`;
    labelEl.textContent = row.title;
    gridEl.appendChild(labelEl);
    
    // 2. Create Bar Area (this spans all time columns)
    const barAreaEl = document.createElement('div');
    barAreaEl.className = `gantt-bar-area ${isSwimlane ? 'swimlane' : 'task'}`;
    barAreaEl.style.gridColumn = `2 / span ${numCols}`;
    barAreaEl.style.gridTemplateColumns = `repeat(${numCols}, 1fr)`;
    
    // Add empty cells for vertical grid lines
    for (let i = 1; i <= numCols; i++) {
      const cell = document.createElement('span');
      cell.setAttribute('data-col', i);
      barAreaEl.appendChild(cell);
    }

    // 3. Add the bar (if it's a task and has bar data)
    //
    // <-- UPDATED LOGIC: Check for bar and non-null startCol
    //
    if (!isSwimlane && row.bar && row.bar.startCol != null) {
      const bar = row.bar;
      
      const barEl = document.createElement('div');
      barEl.className = 'gantt-bar';
      barEl.setAttribute('data-color', bar.color || 'default');
      
      // Position the bar using grid-column (from data)
      barEl.style.gridColumn = `${bar.startCol} / ${bar.endCol}`;
      
      barAreaEl.appendChild(barEl);
    }
    
    gridEl.appendChild(barAreaEl);
  }

  chartWrapper.appendChild(gridEl);
  
  // --- Add Export Button ---
  const exportContainer = document.createElement('div');
  exportContainer.className = 'export-container';
  const exportBtn = document.createElement('button');
  exportBtn.id = 'export-png-btn';
  exportBtn.className = 'export-button';
  exportBtn.textContent = 'Export as PNG';
  exportContainer.appendChild(exportBtn);
  
  // Add the chart and button to the page
  container.appendChild(chartWrapper);
  container.appendChild(exportContainer);

  // --- Add Export Functionality ---
  addExportListener();
}

/**
 * Finds the export button and chart container, then
 * adds a click listener to trigger html2canvas.
 */
function addExportListener() {
  const exportBtn = document.getElementById('export-png-btn');
  // We capture the wrapper, which includes the title
  const chartContainer = document.getElementById('gantt-chart-container');

  if (!exportBtn || !chartContainer) {
    console.warn("Export button or chart container not found.");
    return;
  }

  exportBtn.addEventListener('click', () => {
    exportBtn.textContent = 'Exporting...';
    exportBtn.disabled = true;

    // Use html2canvas (which is loaded in index.html)
    html2canvas(chartContainer, { 
      useCORS: true,
      logging: false,
      scale: 2 // Render at 2x resolution for better quality
    }).then(canvas => {
      const link = document.createElement('a');
      link.download = 'gantt-chart.png';
      link.href = canvas.toDataURL('image/png');
      link.click();
      
      exportBtn.textContent = 'Export as PNG';
      exportBtn.disabled = false;
    }).catch(err => {
      console.error("Error exporting canvas:", err);
      exportBtn.textContent = 'Export as PNG';
      exportBtn.disabled = false;
      alert("Error exporting chart. See console for details.");
    });
  });
}