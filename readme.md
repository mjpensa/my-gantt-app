Dynamic Gantt Chart Generator

This is a Node.js web application that uses the Gemini API to analyze project plans and dynamically generate a custom HTML/CSS Gantt chart.

How It Works

Frontend: The user enters a prompt and uploads research files (.md, .docx, etc.) via the public/index.html page.

Backend: The server.js (Express) file receives this data at the /generate-chart endpoint.

File Parsing: The server extracts text from the uploaded files.

AI Analysis: The server sends the user's prompt and the extracted text to the Gemini API, requesting a structured JSON response.

Dynamic Rendering: The server sends the ganttData JSON back to the frontend. public/main.js then builds the custom HTML chart based on this data, maintaining the exact CSS styling.

Deployment to Railway

This project is configured for a simple deployment on Railway.

1. Local Setup (Optional, but recommended):

Create a file named .env in the root of your project.

Add your Gemini API key to it:

API_KEY=YOUR_GEMINI_API_KEY_HERE


Run npm install to install dependencies.

Run npm start to test the server locally.

2. Railway Deployment:

Push to GitHub: Create a new repository on GitHub and push all these files:

server.js

package.json

README.md

public/ (directory)

index.html

style.css

main.js

Create Railway Project:

Log in to your Railway dashboard.

Click "New Project".

Select "Deploy from GitHub repo".

Choose your new repository.

Railway will automatically detect the package.json and Dockerfile (or create one for Node.js) and use npm start as the deploy command.

Add Environment Variable:

In your Railway project, go to the "Variables" tab.

Click "New Variable".

Add API_KEY as the variable name.

Paste your Gemini API key as the value.

Railway will automatically redeploy your service with this new variable.

That's it! Your application will be live at the public URL provided by Railway.