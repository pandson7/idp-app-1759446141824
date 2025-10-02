# Design Document

## Architecture Overview

The IDP application follows a serverless architecture using AWS services to provide scalable document processing capabilities. The system consists of a React frontend, API Gateway for REST endpoints, Lambda functions for processing logic, S3 for document storage, DynamoDB for results storage, and Amazon Bedrock for AI-powered OCR, classification, and summarization.

## System Components

### Frontend Layer
- **React Web Application**: Simple UI for document upload and results display
- **CloudFront Distribution**: Content delivery and caching
- **S3 Static Website Hosting**: Hosts the React application

### API Layer
- **API Gateway**: RESTful endpoints for document upload and results retrieval
- **Lambda Functions**: Serverless compute for business logic

### Processing Layer
- **OCR Lambda Function**: Extracts text from documents using Amazon Textract
- **Classification Lambda Function**: Categorizes documents using Amazon Bedrock
- **Summarization Lambda Function**: Generates summaries using Amazon Bedrock

### Storage Layer
- **S3 Bucket**: Stores uploaded documents securely
- **DynamoDB Table**: Stores processing results with flexible schema

### AI/ML Services
- **Amazon Textract**: OCR text extraction from documents
- **Amazon Bedrock**: Claude Sonnet model for classification and summarization

## Data Flow

1. User uploads document through React frontend
2. API Gateway receives upload request and triggers Upload Lambda
3. Upload Lambda stores document in S3 and creates DynamoDB record
4. S3 event triggers OCR Lambda function
5. OCR Lambda extracts text using Textract and updates DynamoDB
6. OCR completion triggers Classification Lambda
7. Classification Lambda categorizes document using Bedrock and updates DynamoDB
8. Classification completion triggers Summarization Lambda
9. Summarization Lambda generates summary using Bedrock and updates DynamoDB
10. Frontend polls API for results and displays completed processing

## Database Schema

### DynamoDB Table: idp-results-{suffix}
```json
{
  "documentId": "string (partition key)",
  "uploadTimestamp": "number (sort key)",
  "fileName": "string",
  "s3Key": "string",
  "status": "string", // "uploaded", "ocr-complete", "classified", "summarized"
  "ocrResults": {
    "extractedText": "string",
    "confidence": "number",
    "processedAt": "number"
  },
  "classification": {
    "category": "string",
    "confidence": "number",
    "processedAt": "number"
  },
  "summary": {
    "text": "string",
    "processedAt": "number"
  }
}
```

## API Endpoints

### POST /upload
- Accepts multipart file upload
- Returns documentId and upload status

### GET /results/{documentId}
- Returns processing results for a document
- Includes current processing status

### GET /results
- Returns list of all processed documents
- Supports pagination

## Security Considerations

- S3 bucket with private access and signed URLs
- API Gateway with CORS configuration
- Lambda functions with least privilege IAM roles
- DynamoDB with encryption at rest
- CloudFront with HTTPS enforcement

## Performance Considerations

- Lambda functions with appropriate memory allocation
- DynamoDB with provisioned billing mode for predictable performance
- S3 with intelligent tiering for cost optimization
- CloudFront caching for frontend assets

## Error Handling

- Comprehensive error logging in CloudWatch
- Graceful error handling in Lambda functions
- User-friendly error messages in frontend
- Retry mechanisms for transient failures
