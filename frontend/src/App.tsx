import React, { useState, useEffect } from 'react';
import './App.css';

const API_URL = 'https://bi23gaqewi.execute-api.us-east-1.amazonaws.com/prod';

interface ProcessingResult {
  documentId: string;
  uploadTimestamp: number;
  fileName: string;
  status: string;
  ocrResults?: {
    extractedText: string;
    confidence: number;
    processedAt: number;
  };
  classification?: {
    category: string;
    confidence: number;
    processedAt: number;
  };
  summary?: {
    text: string;
    processedAt: number;
  };
}

function App() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [results, setResults] = useState<ProcessingResult[]>([]);
  const [currentDocumentId, setCurrentDocumentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      setSelectedFile(file);
      setError(null);
    }
  };

  const convertFileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => {
        const result = reader.result as string;
        const base64 = result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = error => reject(error);
    });
  };

  const handleUpload = async () => {
    if (!selectedFile) return;

    setUploading(true);
    setError(null);

    try {
      const base64File = await convertFileToBase64(selectedFile);
      
      const response = await fetch(`${API_URL}/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          file: base64File,
          fileName: selectedFile.name,
          contentType: selectedFile.type
        })
      });

      if (!response.ok) {
        throw new Error(`Upload failed: ${response.statusText}`);
      }

      const result = await response.json();
      setCurrentDocumentId(result.documentId);
      setSelectedFile(null);
      
      // Reset file input
      const fileInput = document.getElementById('fileInput') as HTMLInputElement;
      if (fileInput) fileInput.value = '';

      // Start polling for results
      pollForResults(result.documentId);
      
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const pollForResults = async (documentId: string) => {
    const maxAttempts = 30; // 5 minutes with 10-second intervals
    let attempts = 0;

    const poll = async () => {
      try {
        const response = await fetch(`${API_URL}/results/${documentId}`);
        if (response.ok) {
          const result = await response.json();
          
          // Update results
          setResults(prev => {
            const existing = prev.find(r => r.documentId === documentId);
            if (existing) {
              return prev.map(r => r.documentId === documentId ? result : r);
            } else {
              return [result, ...prev];
            }
          });

          // Continue polling if not complete
          if (result.status !== 'summarized' && attempts < maxAttempts) {
            attempts++;
            setTimeout(poll, 10000); // Poll every 10 seconds
          }
        }
      } catch (err) {
        console.error('Polling error:', err);
      }
    };

    poll();
  };

  const fetchAllResults = async () => {
    try {
      const response = await fetch(`${API_URL}/results`);
      if (response.ok) {
        const allResults = await response.json();
        setResults(allResults);
      }
    } catch (err) {
      console.error('Failed to fetch results:', err);
    }
  };

  useEffect(() => {
    fetchAllResults();
  }, []);

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'uploaded': return '#ffa500';
      case 'ocr-complete': return '#ffff00';
      case 'classified': return '#add8e6';
      case 'summarized': return '#90ee90';
      default: return '#cccccc';
    }
  };

  const formatTimestamp = (timestamp: number) => {
    return new Date(timestamp).toLocaleString();
  };

  return (
    <div className="App">
      <header className="App-header">
        <h1>Intelligent Document Processing</h1>
        
        <div className="upload-section">
          <h2>Upload Document</h2>
          <div className="upload-controls">
            <input
              id="fileInput"
              type="file"
              accept=".pdf,.png,.jpg,.jpeg,.tiff,.bmp"
              onChange={handleFileSelect}
              disabled={uploading}
            />
            <button
              onClick={handleUpload}
              disabled={!selectedFile || uploading}
              className="upload-button"
            >
              {uploading ? 'Uploading...' : 'Upload & Process'}
            </button>
          </div>
          
          {error && (
            <div className="error-message">
              Error: {error}
            </div>
          )}
        </div>

        <div className="results-section">
          <h2>Processing Results</h2>
          {results.length === 0 ? (
            <p>No documents processed yet.</p>
          ) : (
            <div className="results-list">
              {results.map((result) => (
                <div key={result.documentId} className="result-card">
                  <div className="result-header">
                    <h3>{result.fileName}</h3>
                    <div 
                      className="status-badge"
                      style={{ backgroundColor: getStatusColor(result.status) }}
                    >
                      {result.status.replace('-', ' ').toUpperCase()}
                    </div>
                  </div>
                  
                  <p className="upload-time">
                    Uploaded: {formatTimestamp(result.uploadTimestamp)}
                  </p>

                  {result.ocrResults && (
                    <div className="processing-result">
                      <h4>OCR Results</h4>
                      <p><strong>Confidence:</strong> {result.ocrResults.confidence.toFixed(2)}%</p>
                      <div className="extracted-text">
                        <strong>Extracted Text:</strong>
                        <pre>{result.ocrResults.extractedText}</pre>
                      </div>
                    </div>
                  )}

                  {result.classification && (
                    <div className="processing-result">
                      <h4>Classification</h4>
                      <p><strong>Category:</strong> {result.classification.category}</p>
                      <p><strong>Confidence:</strong> {result.classification.confidence.toFixed(2)}%</p>
                    </div>
                  )}

                  {result.summary && (
                    <div className="processing-result">
                      <h4>Summary</h4>
                      <p>{result.summary.text}</p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </header>
    </div>
  );
}

export default App;
