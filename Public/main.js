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
    // 3. Call the backend API (for the *initial* chart)
    const response = await fetch('/generate-chart', {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || `Server error: ${response.status}`);
    }

    // 4. Get the JSON data from the server
    // *** FIX: The server sends the object *directly* now. ***
    const ganttData = await response.json();

    // 5. Validate the data structure
    if (!ganttData || !ganttData.timeColumns || !ganttData.data) {
      throw new Error('Invalid chart data received from server');
    }

    // 6. Render the chart
    setupChart(ganttData);

  } catch (error) {
    console.error("Error generating chart:", error);
    errorMessage.textContent = `Error: ${error.message}`;
    errorMessage.style.display = 'block';
  } finally {
    // 7. Restore UI
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
  
  // --- Dynamic Grid Columns ---
  const numCols = ganttData.timeColumns.length;
  gridEl.style.gridTemplateColumns = `minmax(220px, 1.5fr) repeat(${numCols}, 1fr)`;

  // --- Create Header Row ---
  const headerLabel = document.createElement('div');
  headerLabel.className = 'gantt-header gantt-header-label';
  gridEl.appendChild(headerLabel);
  
  for (const colName of ganttData.timeColumns) {
    const headerCell = document.createElement('div');
    headerCell.className = 'gantt-header';
    headerCell.textContent = colName;
    gridEl.appendChild(headerCell);
  }

  // --- Create Data Rows ---
  for (const row of ganttData.data) {
    const isSwimlane = row.isSwimlane;
    
    // 1. Create Label Cell
    const labelEl = document.createElement('div');
    labelEl.className = `gantt-row-label ${isSwimlane ? 'swimlane' : 'task'}`;
    labelEl.textContent = row.title;
    gridEl.appendChild(labelEl);
    
    // 2. Create Bar Area
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
    if (!isSwimlane && row.bar && row.bar.startCol != null) {
      const bar = row.bar;
      
      const barEl = document.createElement('div');
      barEl.className = 'gantt-bar';
      barEl.setAttribute('data-color', bar.color || 'default');
      barEl.style.gridColumn = `${bar.startCol} / ${bar.endCol}`;
      
      barAreaEl.appendChild(barEl);

      // --- NEW: Add click listener for analysis ---
      // We make both the label and the bar area clickable
      const taskIdentifier = { taskName: row.title, entity: row.entity };
      labelEl.addEventListener('click', () => showAnalysisModal(taskIdentifier));
      barAreaEl.addEventListener('click', () => showAnalysisModal(taskIdentifier));
      labelEl.style.cursor = 'pointer';
      barAreaEl.style.cursor = 'pointer';
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

  // Add Export Functionality
  addExportListener();
}

/**
 * Finds the export button and chart container, then
 * adds a click listener to trigger html2canvas.
 */
function addExportListener() {
  const exportBtn = document.getElementById('export-png-btn');
  const chartContainer = document.getElementById('gantt-chart-container');

  if (!exportBtn || !chartContainer) {
    console.warn("Export button or chart container not found.");
    return;
  }

  exportBtn.addEventListener('click', () => {
    exportBtn.textContent = 'Exporting...';
    exportBtn.disabled = true;

    html2canvas(chartContainer, { 
      useCORS: true,
      logging: false,
      scale: 2 // Render at 2x resolution
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

// -------------------------------------------------------------------
// --- NEW: "ON-DEMAND" ANALYSIS MODAL ---
// -------------------------------------------------------------------

/**
 * Creates and shows the analysis modal.
 * Fetches data from the new /get-task-analysis endpoint.
 */
async function showAnalysisModal(taskIdentifier) {
  // 1. Remove any old modal
  document.getElementById('analysis-modal')?.remove();

  // 2. Create modal structure
  const modalOverlay = document.createElement('div');
  modalOverlay.id = 'analysis-modal';
  modalOverlay.className = 'modal-overlay';
  
  const modalContent = document.createElement('div');
  modalContent.className = 'modal-content';
  
  modalContent.innerHTML = `
    <div class="modal-header">
      <h3 class="modal-title">Analyzing...</h3>
      <button class="modal-close" id="modal-close-btn">&times;</button>
    </div>
    <div class="modal-body" id="modal-body-content">
      <div class="modal-spinner"></div>
    </div>
  `;
  
  modalOverlay.appendChild(modalContent);
  document.body.appendChild(modalOverlay);

  // 3. Add close listeners
  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) {
      modalOverlay.remove();
    }
  });
  document.getElementById('modal-close-btn').addEventListener('click', () => {
    modalOverlay.remove();
  });

  // 4. Fetch the analysis data
  try {
    const response = await fetch('/get-task-analysis', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(taskIdentifier)
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || "Server error");
    }

    const analysis = await response.json();

    // 5. Populate the modal with the analysis
    document.querySelector('.modal-title').textContent = analysis.taskName;
    document.getElementById('modal-body-content').innerHTML = `
      ${buildAnalysisSection('Status', `<span class="status-pill status-${analysis.status.replace(/\s+/g, '-').toLowerCase()}">${analysis.status}</span>`)}
      ${buildAnalysisSection('Dates', `${analysis.startDate || 'N/A'} to ${analysis.endDate || 'N/A'}`)}
      ${buildAnalysisList('Facts', analysis.facts, 'fact', 'source')}
      ${buildAnalysisList('Assumptions', analysis.assumptions, 'assumption', 'source')}
      ${buildAnalysisSection('Summary', analysis.summary)}
      ${buildAnalysisSection('Rationale / Hurdles', analysis.rationale)}
    `;

  } catch (error) {
    console.error("Error fetching analysis:", error);
    document.getElementById('modal-body-content').innerHTML = `<div class="modal-error">Failed to load analysis: ${error.message}</div>`;
  }
}

// Helper function to build a section of the modal
function buildAnalysisSection(title, content) {
  if (!content) return ''; // Don't show empty sections
  return `
    <div class="analysis-section">
      <h4>${title}</h4>
      <p>${content}</p>
    </div>
  `;
}

// Helper function to build a list of facts/assumptions
function buildAnalysisList(title, items, itemKey, sourceKey) {
  if (!items || items.length === 0) return '';
  
  const listItems = items.map(item => 
    `<li>
      <p>${item[itemKey]}</p>
      <span class="source">(Source: ${item[sourceKey]})</span>
    </li>`
  ).join('');
  
  return `
    <div class="analysis-section">
      <h4>${title}</h4>
      <ul class="analysis-list">${listItems}</ul>
    </div>
  `;
}