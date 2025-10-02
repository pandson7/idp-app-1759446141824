"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CdkAppStack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const s3 = __importStar(require("aws-cdk-lib/aws-s3"));
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const dynamodb = __importStar(require("aws-cdk-lib/aws-dynamodb"));
const apigateway = __importStar(require("aws-cdk-lib/aws-apigateway"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const s3n = __importStar(require("aws-cdk-lib/aws-s3-notifications"));
const cloudfront = __importStar(require("aws-cdk-lib/aws-cloudfront"));
const origins = __importStar(require("aws-cdk-lib/aws-cloudfront-origins"));
class CdkAppStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        const suffix = '1759446141824';
        // DynamoDB table for storing processing results
        const resultsTable = new dynamodb.Table(this, `IdpResultsTable${suffix}`, {
            tableName: `idp-results-${suffix}`,
            partitionKey: { name: 'documentId', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'uploadTimestamp', type: dynamodb.AttributeType.NUMBER },
            billingMode: dynamodb.BillingMode.PROVISIONED,
            readCapacity: 5,
            writeCapacity: 5,
            encryption: dynamodb.TableEncryption.AWS_MANAGED,
            removalPolicy: cdk.RemovalPolicy.DESTROY
        });
        // S3 bucket for document storage
        const documentsBucket = new s3.Bucket(this, `DocumentsBucket${suffix}`, {
            bucketName: `idp-documents-${suffix}`,
            versioned: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true
        });
        // S3 bucket for frontend hosting
        const frontendBucket = new s3.Bucket(this, `FrontendBucket${suffix}`, {
            bucketName: `idp-frontend-${suffix}`,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true
        });
        // IAM role for Lambda functions
        const lambdaRole = new iam.Role(this, `LambdaRole${suffix}`, {
            roleName: `idp-lambda-role-${suffix}`,
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
            ],
            inlinePolicies: {
                IdpPolicy: new iam.PolicyDocument({
                    statements: [
                        new iam.PolicyStatement({
                            effect: iam.Effect.ALLOW,
                            actions: [
                                's3:GetObject',
                                's3:PutObject',
                                's3:DeleteObject'
                            ],
                            resources: [documentsBucket.bucketArn + '/*']
                        }),
                        new iam.PolicyStatement({
                            effect: iam.Effect.ALLOW,
                            actions: [
                                'dynamodb:PutItem',
                                'dynamodb:GetItem',
                                'dynamodb:UpdateItem',
                                'dynamodb:Query',
                                'dynamodb:Scan'
                            ],
                            resources: [resultsTable.tableArn]
                        }),
                        new iam.PolicyStatement({
                            effect: iam.Effect.ALLOW,
                            actions: [
                                'textract:DetectDocumentText',
                                'textract:AnalyzeDocument'
                            ],
                            resources: ['*']
                        }),
                        new iam.PolicyStatement({
                            effect: iam.Effect.ALLOW,
                            actions: [
                                'bedrock:InvokeModel'
                            ],
                            resources: [
                                'arn:aws:bedrock:*:*:inference-profile/global.anthropic.claude-sonnet-4-20250514-v1:0',
                                'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-20250514-v1:0'
                            ]
                        }),
                        new iam.PolicyStatement({
                            effect: iam.Effect.ALLOW,
                            actions: [
                                'lambda:InvokeFunction'
                            ],
                            resources: ['*']
                        })
                    ]
                })
            }
        });
        // Upload Lambda function
        const uploadLambda = new lambda.Function(this, `UploadLambda${suffix}`, {
            functionName: `idp-upload-${suffix}`,
            runtime: lambda.Runtime.PYTHON_3_11,
            handler: 'index.handler',
            role: lambdaRole,
            timeout: cdk.Duration.seconds(30),
            environment: {
                DOCUMENTS_BUCKET: documentsBucket.bucketName,
                RESULTS_TABLE: resultsTable.tableName
            },
            code: lambda.Code.fromInline(`
import json
import boto3
import uuid
import base64
import os
from datetime import datetime

s3 = boto3.client('s3')
dynamodb = boto3.resource('dynamodb')

def handler(event, context):
    try:
        table = dynamodb.Table(os.environ['RESULTS_TABLE'])
        bucket = os.environ['DOCUMENTS_BUCKET']
        
        # Parse the request
        body = json.loads(event['body'])
        file_content = base64.b64decode(body['file'])
        file_name = body['fileName']
        
        # Generate unique document ID
        document_id = str(uuid.uuid4())
        timestamp = int(datetime.now().timestamp() * 1000)
        s3_key = f"{document_id}/{file_name}"
        
        # Upload to S3
        s3.put_object(
            Bucket=bucket,
            Key=s3_key,
            Body=file_content,
            ContentType=body.get('contentType', 'application/octet-stream')
        )
        
        # Create DynamoDB record
        table.put_item(
            Item={
                'documentId': document_id,
                'uploadTimestamp': timestamp,
                'fileName': file_name,
                's3Key': s3_key,
                'status': 'uploaded'
            }
        )
        
        return {
            'statusCode': 200,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Allow-Methods': 'POST, OPTIONS'
            },
            'body': json.dumps({
                'documentId': document_id,
                'status': 'uploaded'
            })
        }
        
    except Exception as e:
        return {
            'statusCode': 500,
            'headers': {
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps({'error': str(e)})
        }
`)
        });
        // OCR Lambda function
        const ocrLambda = new lambda.Function(this, `OcrLambda${suffix}`, {
            functionName: `idp-ocr-${suffix}`,
            runtime: lambda.Runtime.PYTHON_3_11,
            handler: 'index.handler',
            role: lambdaRole,
            timeout: cdk.Duration.seconds(300),
            environment: {
                DOCUMENTS_BUCKET: documentsBucket.bucketName,
                RESULTS_TABLE: resultsTable.tableName,
                CLASSIFICATION_LAMBDA: `idp-classification-${suffix}`
            },
            code: lambda.Code.fromInline(`
import json
import boto3
import os
from datetime import datetime
from boto3.dynamodb.conditions import Key
from decimal import Decimal

textract = boto3.client('textract')
dynamodb = boto3.resource('dynamodb')
lambda_client = boto3.client('lambda')

def handler(event, context):
    try:
        # Parse S3 event
        bucket = event['Records'][0]['s3']['bucket']['name']
        key = event['Records'][0]['s3']['object']['key']
        
        # Extract document ID from key
        document_id = key.split('/')[0]
        
        # Get the document record to find the timestamp
        table = dynamodb.Table(os.environ['RESULTS_TABLE'])
        response = table.query(
            KeyConditionExpression=Key('documentId').eq(document_id)
        )
        
        if not response['Items']:
            print(f"No record found for document ID: {document_id}")
            return {'statusCode': 404}
        
        item = response['Items'][0]
        timestamp = item['uploadTimestamp']
        
        # Perform OCR using Textract
        response = textract.detect_document_text(
            Document={
                'S3Object': {
                    'Bucket': bucket,
                    'Name': key
                }
            }
        )
        
        # Extract text
        extracted_text = ""
        confidence_scores = []
        
        for block in response['Blocks']:
            if block['BlockType'] == 'LINE':
                extracted_text += block['Text'] + "\\n"
                confidence_scores.append(block['Confidence'])
        
        avg_confidence = Decimal(str(sum(confidence_scores) / len(confidence_scores))) if confidence_scores else Decimal('0')
        
        # Update DynamoDB
        table.update_item(
            Key={'documentId': document_id, 'uploadTimestamp': timestamp},
            UpdateExpression='SET ocrResults = :ocr, #status = :status',
            ExpressionAttributeNames={'#status': 'status'},
            ExpressionAttributeValues={
                ':ocr': {
                    'extractedText': extracted_text,
                    'confidence': avg_confidence,
                    'processedAt': Decimal(str(int(datetime.now().timestamp() * 1000)))
                },
                ':status': 'ocr-complete'
            }
        )
        
        # Trigger classification
        lambda_client.invoke(
            FunctionName=os.environ['CLASSIFICATION_LAMBDA'],
            InvocationType='Event',
            Payload=json.dumps({'documentId': document_id, 'timestamp': int(timestamp), 'text': extracted_text})
        )
        
        return {'statusCode': 200}
        
    except Exception as e:
        print(f"Error: {str(e)}")
        return {'statusCode': 500, 'body': json.dumps({'error': str(e)})}
`)
        });
        // Classification Lambda function
        const classificationLambda = new lambda.Function(this, `ClassificationLambda${suffix}`, {
            functionName: `idp-classification-${suffix}`,
            runtime: lambda.Runtime.PYTHON_3_11,
            handler: 'index.handler',
            role: lambdaRole,
            timeout: cdk.Duration.seconds(300),
            environment: {
                RESULTS_TABLE: resultsTable.tableName,
                SUMMARIZATION_LAMBDA: `idp-summarization-${suffix}`
            },
            code: lambda.Code.fromInline(`
import json
import boto3
import os
from datetime import datetime
from decimal import Decimal

bedrock = boto3.client('bedrock-runtime')
dynamodb = boto3.resource('dynamodb')
lambda_client = boto3.client('lambda')

def handler(event, context):
    try:
        document_id = event['documentId']
        timestamp = event['timestamp']
        text = event['text']
        
        # Classify document using Bedrock
        prompt = f"""Classify the following document text into one of these categories:
        - Invoice
        - Contract
        - Report
        - Letter
        - Form
        - Other
        
        Document text:
        {text[:2000]}
        
        Respond with only the category name."""
        
        response = bedrock.invoke_model(
            modelId='global.anthropic.claude-sonnet-4-20250514-v1:0',
            body=json.dumps({
                'anthropic_version': 'bedrock-2023-05-31',
                'max_tokens': 100,
                'messages': [{'role': 'user', 'content': prompt}]
            })
        )
        
        result = json.loads(response['body'].read())
        category = result['content'][0]['text'].strip()
        
        # Update DynamoDB
        table = dynamodb.Table(os.environ['RESULTS_TABLE'])
        table.update_item(
            Key={'documentId': document_id, 'uploadTimestamp': Decimal(str(timestamp))},
            UpdateExpression='SET classification = :classification, #status = :status',
            ExpressionAttributeNames={'#status': 'status'},
            ExpressionAttributeValues={
                ':classification': {
                    'category': category,
                    'confidence': Decimal('0.85'),
                    'processedAt': Decimal(str(int(datetime.now().timestamp() * 1000)))
                },
                ':status': 'classified'
            }
        )
        
        # Trigger summarization
        lambda_client.invoke(
            FunctionName=os.environ['SUMMARIZATION_LAMBDA'],
            InvocationType='Event',
            Payload=json.dumps({'documentId': document_id, 'timestamp': timestamp, 'text': text})
        )
        
        return {'statusCode': 200}
        
    except Exception as e:
        print(f"Error: {str(e)}")
        return {'statusCode': 500, 'body': json.dumps({'error': str(e)})}
`)
        });
        // Summarization Lambda function
        const summarizationLambda = new lambda.Function(this, `SummarizationLambda${suffix}`, {
            functionName: `idp-summarization-${suffix}`,
            runtime: lambda.Runtime.PYTHON_3_11,
            handler: 'index.handler',
            role: lambdaRole,
            timeout: cdk.Duration.seconds(300),
            environment: {
                RESULTS_TABLE: resultsTable.tableName
            },
            code: lambda.Code.fromInline(`
import json
import boto3
import os
from datetime import datetime
from decimal import Decimal

bedrock = boto3.client('bedrock-runtime')
dynamodb = boto3.resource('dynamodb')

def handler(event, context):
    try:
        document_id = event['documentId']
        timestamp = event['timestamp']
        text = event['text']
        
        # Summarize document using Bedrock
        prompt = f"""Provide a concise summary of the following document in 2-3 sentences:
        
        {text[:3000]}
        
        Summary:"""
        
        response = bedrock.invoke_model(
            modelId='global.anthropic.claude-sonnet-4-20250514-v1:0',
            body=json.dumps({
                'anthropic_version': 'bedrock-2023-05-31',
                'max_tokens': 200,
                'messages': [{'role': 'user', 'content': prompt}]
            })
        )
        
        result = json.loads(response['body'].read())
        summary = result['content'][0]['text'].strip()
        
        # Update DynamoDB
        table = dynamodb.Table(os.environ['RESULTS_TABLE'])
        table.update_item(
            Key={'documentId': document_id, 'uploadTimestamp': Decimal(str(timestamp))},
            UpdateExpression='SET summary = :summary, #status = :status',
            ExpressionAttributeNames={'#status': 'status'},
            ExpressionAttributeValues={
                ':summary': {
                    'text': summary,
                    'processedAt': Decimal(str(int(datetime.now().timestamp() * 1000)))
                },
                ':status': 'summarized'
            }
        )
        
        return {'statusCode': 200}
        
    except Exception as e:
        print(f"Error: {str(e)}")
        return {'statusCode': 500, 'body': json.dumps({'error': str(e)})}
`)
        });
        // Results Lambda function
        const resultsLambda = new lambda.Function(this, `ResultsLambda${suffix}`, {
            functionName: `idp-results-${suffix}`,
            runtime: lambda.Runtime.PYTHON_3_11,
            handler: 'index.handler',
            role: lambdaRole,
            timeout: cdk.Duration.seconds(30),
            environment: {
                RESULTS_TABLE: resultsTable.tableName
            },
            code: lambda.Code.fromInline(`
import json
import boto3
import os
from boto3.dynamodb.conditions import Key
from decimal import Decimal

dynamodb = boto3.resource('dynamodb')

class DecimalEncoder(json.JSONEncoder):
    def default(self, o):
        if isinstance(o, Decimal):
            return float(o)
        return super(DecimalEncoder, self).default(o)

def handler(event, context):
    try:
        table = dynamodb.Table(os.environ['RESULTS_TABLE'])
        
        # Handle different HTTP methods
        http_method = event['httpMethod']
        
        if http_method == 'GET':
            path_parameters = event.get('pathParameters', {})
            
            if path_parameters and 'documentId' in path_parameters:
                # Get specific document
                document_id = path_parameters['documentId']
                response = table.query(
                    KeyConditionExpression=Key('documentId').eq(document_id)
                )
                items = response['Items']
                
                return {
                    'statusCode': 200,
                    'headers': {
                        'Access-Control-Allow-Origin': '*',
                        'Access-Control-Allow-Headers': 'Content-Type',
                        'Access-Control-Allow-Methods': 'GET, OPTIONS'
                    },
                    'body': json.dumps(items[0] if items else {}, cls=DecimalEncoder)
                }
            else:
                # Get all documents
                response = table.scan()
                items = response['Items']
                
                return {
                    'statusCode': 200,
                    'headers': {
                        'Access-Control-Allow-Origin': '*',
                        'Access-Control-Allow-Headers': 'Content-Type',
                        'Access-Control-Allow-Methods': 'GET, OPTIONS'
                    },
                    'body': json.dumps(items, cls=DecimalEncoder)
                }
        
        return {
            'statusCode': 405,
            'headers': {
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps({'error': 'Method not allowed'})
        }
        
    except Exception as e:
        return {
            'statusCode': 500,
            'headers': {
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps({'error': str(e)})
        }
`)
        });
        // S3 event notification to trigger OCR
        documentsBucket.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.LambdaDestination(ocrLambda));
        // API Gateway
        const api = new apigateway.RestApi(this, `IdpApi${suffix}`, {
            restApiName: `idp-api-${suffix}`,
            description: 'IDP Application API',
            defaultCorsPreflightOptions: {
                allowOrigins: apigateway.Cors.ALL_ORIGINS,
                allowMethods: apigateway.Cors.ALL_METHODS,
                allowHeaders: ['Content-Type', 'X-Amz-Date', 'Authorization', 'X-Api-Key']
            }
        });
        // API endpoints
        const uploadResource = api.root.addResource('upload');
        uploadResource.addMethod('POST', new apigateway.LambdaIntegration(uploadLambda));
        const resultsResource = api.root.addResource('results');
        resultsResource.addMethod('GET', new apigateway.LambdaIntegration(resultsLambda));
        const resultByIdResource = resultsResource.addResource('{documentId}');
        resultByIdResource.addMethod('GET', new apigateway.LambdaIntegration(resultsLambda));
        // CloudFront distribution for frontend
        const distribution = new cloudfront.Distribution(this, `FrontendDistribution${suffix}`, {
            defaultBehavior: {
                origin: origins.S3BucketOrigin.withOriginAccessControl(frontendBucket),
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS
            },
            defaultRootObject: 'index.html'
        });
        // Outputs
        new cdk.CfnOutput(this, 'ApiUrl', {
            value: api.url,
            description: 'API Gateway URL'
        });
        new cdk.CfnOutput(this, 'FrontendUrl', {
            value: `https://${distribution.distributionDomainName}`,
            description: 'Frontend URL'
        });
        new cdk.CfnOutput(this, 'DocumentsBucket', {
            value: documentsBucket.bucketName,
            description: 'Documents S3 Bucket'
        });
        new cdk.CfnOutput(this, 'ResultsTable', {
            value: resultsTable.tableName,
            description: 'Results DynamoDB Table'
        });
    }
}
exports.CdkAppStack = CdkAppStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2RrLWFwcC1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImNkay1hcHAtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSxpREFBbUM7QUFFbkMsdURBQXlDO0FBQ3pDLCtEQUFpRDtBQUNqRCxtRUFBcUQ7QUFDckQsdUVBQXlEO0FBQ3pELHlEQUEyQztBQUMzQyxzRUFBd0Q7QUFDeEQsdUVBQXlEO0FBQ3pELDRFQUE4RDtBQUU5RCxNQUFhLFdBQVksU0FBUSxHQUFHLENBQUMsS0FBSztJQUN4QyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQXNCO1FBQzlELEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLE1BQU0sTUFBTSxHQUFHLGVBQWUsQ0FBQztRQUUvQixnREFBZ0Q7UUFDaEQsTUFBTSxZQUFZLEdBQUcsSUFBSSxRQUFRLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRSxrQkFBa0IsTUFBTSxFQUFFLEVBQUU7WUFDeEUsU0FBUyxFQUFFLGVBQWUsTUFBTSxFQUFFO1lBQ2xDLFlBQVksRUFBRSxFQUFFLElBQUksRUFBRSxZQUFZLEVBQUUsSUFBSSxFQUFFLFFBQVEsQ0FBQyxhQUFhLENBQUMsTUFBTSxFQUFFO1lBQ3pFLE9BQU8sRUFBRSxFQUFFLElBQUksRUFBRSxpQkFBaUIsRUFBRSxJQUFJLEVBQUUsUUFBUSxDQUFDLGFBQWEsQ0FBQyxNQUFNLEVBQUU7WUFDekUsV0FBVyxFQUFFLFFBQVEsQ0FBQyxXQUFXLENBQUMsV0FBVztZQUM3QyxZQUFZLEVBQUUsQ0FBQztZQUNmLGFBQWEsRUFBRSxDQUFDO1lBQ2hCLFVBQVUsRUFBRSxRQUFRLENBQUMsZUFBZSxDQUFDLFdBQVc7WUFDaEQsYUFBYSxFQUFFLEdBQUcsQ0FBQyxhQUFhLENBQUMsT0FBTztTQUN6QyxDQUFDLENBQUM7UUFFSCxpQ0FBaUM7UUFDakMsTUFBTSxlQUFlLEdBQUcsSUFBSSxFQUFFLENBQUMsTUFBTSxDQUFDLElBQUksRUFBRSxrQkFBa0IsTUFBTSxFQUFFLEVBQUU7WUFDdEUsVUFBVSxFQUFFLGlCQUFpQixNQUFNLEVBQUU7WUFDckMsU0FBUyxFQUFFLElBQUk7WUFDZixVQUFVLEVBQUUsRUFBRSxDQUFDLGdCQUFnQixDQUFDLFVBQVU7WUFDMUMsaUJBQWlCLEVBQUUsRUFBRSxDQUFDLGlCQUFpQixDQUFDLFNBQVM7WUFDakQsYUFBYSxFQUFFLEdBQUcsQ0FBQyxhQUFhLENBQUMsT0FBTztZQUN4QyxpQkFBaUIsRUFBRSxJQUFJO1NBQ3hCLENBQUMsQ0FBQztRQUVILGlDQUFpQztRQUNqQyxNQUFNLGNBQWMsR0FBRyxJQUFJLEVBQUUsQ0FBQyxNQUFNLENBQUMsSUFBSSxFQUFFLGlCQUFpQixNQUFNLEVBQUUsRUFBRTtZQUNwRSxVQUFVLEVBQUUsZ0JBQWdCLE1BQU0sRUFBRTtZQUNwQyxhQUFhLEVBQUUsR0FBRyxDQUFDLGFBQWEsQ0FBQyxPQUFPO1lBQ3hDLGlCQUFpQixFQUFFLElBQUk7U0FDeEIsQ0FBQyxDQUFDO1FBRUgsZ0NBQWdDO1FBQ2hDLE1BQU0sVUFBVSxHQUFHLElBQUksR0FBRyxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsYUFBYSxNQUFNLEVBQUUsRUFBRTtZQUMzRCxRQUFRLEVBQUUsbUJBQW1CLE1BQU0sRUFBRTtZQUNyQyxTQUFTLEVBQUUsSUFBSSxHQUFHLENBQUMsZ0JBQWdCLENBQUMsc0JBQXNCLENBQUM7WUFDM0QsZUFBZSxFQUFFO2dCQUNmLEdBQUcsQ0FBQyxhQUFhLENBQUMsd0JBQXdCLENBQUMsMENBQTBDLENBQUM7YUFDdkY7WUFDRCxjQUFjLEVBQUU7Z0JBQ2QsU0FBUyxFQUFFLElBQUksR0FBRyxDQUFDLGNBQWMsQ0FBQztvQkFDaEMsVUFBVSxFQUFFO3dCQUNWLElBQUksR0FBRyxDQUFDLGVBQWUsQ0FBQzs0QkFDdEIsTUFBTSxFQUFFLEdBQUcsQ0FBQyxNQUFNLENBQUMsS0FBSzs0QkFDeEIsT0FBTyxFQUFFO2dDQUNQLGNBQWM7Z0NBQ2QsY0FBYztnQ0FDZCxpQkFBaUI7NkJBQ2xCOzRCQUNELFNBQVMsRUFBRSxDQUFDLGVBQWUsQ0FBQyxTQUFTLEdBQUcsSUFBSSxDQUFDO3lCQUM5QyxDQUFDO3dCQUNGLElBQUksR0FBRyxDQUFDLGVBQWUsQ0FBQzs0QkFDdEIsTUFBTSxFQUFFLEdBQUcsQ0FBQyxNQUFNLENBQUMsS0FBSzs0QkFDeEIsT0FBTyxFQUFFO2dDQUNQLGtCQUFrQjtnQ0FDbEIsa0JBQWtCO2dDQUNsQixxQkFBcUI7Z0NBQ3JCLGdCQUFnQjtnQ0FDaEIsZUFBZTs2QkFDaEI7NEJBQ0QsU0FBUyxFQUFFLENBQUMsWUFBWSxDQUFDLFFBQVEsQ0FBQzt5QkFDbkMsQ0FBQzt3QkFDRixJQUFJLEdBQUcsQ0FBQyxlQUFlLENBQUM7NEJBQ3RCLE1BQU0sRUFBRSxHQUFHLENBQUMsTUFBTSxDQUFDLEtBQUs7NEJBQ3hCLE9BQU8sRUFBRTtnQ0FDUCw2QkFBNkI7Z0NBQzdCLDBCQUEwQjs2QkFDM0I7NEJBQ0QsU0FBUyxFQUFFLENBQUMsR0FBRyxDQUFDO3lCQUNqQixDQUFDO3dCQUNGLElBQUksR0FBRyxDQUFDLGVBQWUsQ0FBQzs0QkFDdEIsTUFBTSxFQUFFLEdBQUcsQ0FBQyxNQUFNLENBQUMsS0FBSzs0QkFDeEIsT0FBTyxFQUFFO2dDQUNQLHFCQUFxQjs2QkFDdEI7NEJBQ0QsU0FBUyxFQUFFO2dDQUNULHNGQUFzRjtnQ0FDdEYsNkVBQTZFOzZCQUM5RTt5QkFDRixDQUFDO3dCQUNGLElBQUksR0FBRyxDQUFDLGVBQWUsQ0FBQzs0QkFDdEIsTUFBTSxFQUFFLEdBQUcsQ0FBQyxNQUFNLENBQUMsS0FBSzs0QkFDeEIsT0FBTyxFQUFFO2dDQUNQLHVCQUF1Qjs2QkFDeEI7NEJBQ0QsU0FBUyxFQUFFLENBQUMsR0FBRyxDQUFDO3lCQUNqQixDQUFDO3FCQUNIO2lCQUNGLENBQUM7YUFDSDtTQUNGLENBQUMsQ0FBQztRQUVILHlCQUF5QjtRQUN6QixNQUFNLFlBQVksR0FBRyxJQUFJLE1BQU0sQ0FBQyxRQUFRLENBQUMsSUFBSSxFQUFFLGVBQWUsTUFBTSxFQUFFLEVBQUU7WUFDdEUsWUFBWSxFQUFFLGNBQWMsTUFBTSxFQUFFO1lBQ3BDLE9BQU8sRUFBRSxNQUFNLENBQUMsT0FBTyxDQUFDLFdBQVc7WUFDbkMsT0FBTyxFQUFFLGVBQWU7WUFDeEIsSUFBSSxFQUFFLFVBQVU7WUFDaEIsT0FBTyxFQUFFLEdBQUcsQ0FBQyxRQUFRLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQztZQUNqQyxXQUFXLEVBQUU7Z0JBQ1gsZ0JBQWdCLEVBQUUsZUFBZSxDQUFDLFVBQVU7Z0JBQzVDLGFBQWEsRUFBRSxZQUFZLENBQUMsU0FBUzthQUN0QztZQUNELElBQUksRUFBRSxNQUFNLENBQUMsSUFBSSxDQUFDLFVBQVUsQ0FBQzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBa0VsQyxDQUFDO1NBQ0csQ0FBQyxDQUFDO1FBRUgsc0JBQXNCO1FBQ3RCLE1BQU0sU0FBUyxHQUFHLElBQUksTUFBTSxDQUFDLFFBQVEsQ0FBQyxJQUFJLEVBQUUsWUFBWSxNQUFNLEVBQUUsRUFBRTtZQUNoRSxZQUFZLEVBQUUsV0FBVyxNQUFNLEVBQUU7WUFDakMsT0FBTyxFQUFFLE1BQU0sQ0FBQyxPQUFPLENBQUMsV0FBVztZQUNuQyxPQUFPLEVBQUUsZUFBZTtZQUN4QixJQUFJLEVBQUUsVUFBVTtZQUNoQixPQUFPLEVBQUUsR0FBRyxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDO1lBQ2xDLFdBQVcsRUFBRTtnQkFDWCxnQkFBZ0IsRUFBRSxlQUFlLENBQUMsVUFBVTtnQkFDNUMsYUFBYSxFQUFFLFlBQVksQ0FBQyxTQUFTO2dCQUNyQyxxQkFBcUIsRUFBRSxzQkFBc0IsTUFBTSxFQUFFO2FBQ3REO1lBQ0QsSUFBSSxFQUFFLE1BQU0sQ0FBQyxJQUFJLENBQUMsVUFBVSxDQUFDOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBa0ZsQyxDQUFDO1NBQ0csQ0FBQyxDQUFDO1FBRUgsaUNBQWlDO1FBQ2pDLE1BQU0sb0JBQW9CLEdBQUcsSUFBSSxNQUFNLENBQUMsUUFBUSxDQUFDLElBQUksRUFBRSx1QkFBdUIsTUFBTSxFQUFFLEVBQUU7WUFDdEYsWUFBWSxFQUFFLHNCQUFzQixNQUFNLEVBQUU7WUFDNUMsT0FBTyxFQUFFLE1BQU0sQ0FBQyxPQUFPLENBQUMsV0FBVztZQUNuQyxPQUFPLEVBQUUsZUFBZTtZQUN4QixJQUFJLEVBQUUsVUFBVTtZQUNoQixPQUFPLEVBQUUsR0FBRyxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDO1lBQ2xDLFdBQVcsRUFBRTtnQkFDWCxhQUFhLEVBQUUsWUFBWSxDQUFDLFNBQVM7Z0JBQ3JDLG9CQUFvQixFQUFFLHFCQUFxQixNQUFNLEVBQUU7YUFDcEQ7WUFDRCxJQUFJLEVBQUUsTUFBTSxDQUFDLElBQUksQ0FBQyxVQUFVLENBQUM7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBdUVsQyxDQUFDO1NBQ0csQ0FBQyxDQUFDO1FBRUgsZ0NBQWdDO1FBQ2hDLE1BQU0sbUJBQW1CLEdBQUcsSUFBSSxNQUFNLENBQUMsUUFBUSxDQUFDLElBQUksRUFBRSxzQkFBc0IsTUFBTSxFQUFFLEVBQUU7WUFDcEYsWUFBWSxFQUFFLHFCQUFxQixNQUFNLEVBQUU7WUFDM0MsT0FBTyxFQUFFLE1BQU0sQ0FBQyxPQUFPLENBQUMsV0FBVztZQUNuQyxPQUFPLEVBQUUsZUFBZTtZQUN4QixJQUFJLEVBQUUsVUFBVTtZQUNoQixPQUFPLEVBQUUsR0FBRyxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDO1lBQ2xDLFdBQVcsRUFBRTtnQkFDWCxhQUFhLEVBQUUsWUFBWSxDQUFDLFNBQVM7YUFDdEM7WUFDRCxJQUFJLEVBQUUsTUFBTSxDQUFDLElBQUksQ0FBQyxVQUFVLENBQUM7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0F1RGxDLENBQUM7U0FDRyxDQUFDLENBQUM7UUFFSCwwQkFBMEI7UUFDMUIsTUFBTSxhQUFhLEdBQUcsSUFBSSxNQUFNLENBQUMsUUFBUSxDQUFDLElBQUksRUFBRSxnQkFBZ0IsTUFBTSxFQUFFLEVBQUU7WUFDeEUsWUFBWSxFQUFFLGVBQWUsTUFBTSxFQUFFO1lBQ3JDLE9BQU8sRUFBRSxNQUFNLENBQUMsT0FBTyxDQUFDLFdBQVc7WUFDbkMsT0FBTyxFQUFFLGVBQWU7WUFDeEIsSUFBSSxFQUFFLFVBQVU7WUFDaEIsT0FBTyxFQUFFLEdBQUcsQ0FBQyxRQUFRLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQztZQUNqQyxXQUFXLEVBQUU7Z0JBQ1gsYUFBYSxFQUFFLFlBQVksQ0FBQyxTQUFTO2FBQ3RDO1lBQ0QsSUFBSSxFQUFFLE1BQU0sQ0FBQyxJQUFJLENBQUMsVUFBVSxDQUFDOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBeUVsQyxDQUFDO1NBQ0csQ0FBQyxDQUFDO1FBRUgsdUNBQXVDO1FBQ3ZDLGVBQWUsQ0FBQyxvQkFBb0IsQ0FDbEMsRUFBRSxDQUFDLFNBQVMsQ0FBQyxjQUFjLEVBQzNCLElBQUksR0FBRyxDQUFDLGlCQUFpQixDQUFDLFNBQVMsQ0FBQyxDQUNyQyxDQUFDO1FBRUYsY0FBYztRQUNkLE1BQU0sR0FBRyxHQUFHLElBQUksVUFBVSxDQUFDLE9BQU8sQ0FBQyxJQUFJLEVBQUUsU0FBUyxNQUFNLEVBQUUsRUFBRTtZQUMxRCxXQUFXLEVBQUUsV0FBVyxNQUFNLEVBQUU7WUFDaEMsV0FBVyxFQUFFLHFCQUFxQjtZQUNsQywyQkFBMkIsRUFBRTtnQkFDM0IsWUFBWSxFQUFFLFVBQVUsQ0FBQyxJQUFJLENBQUMsV0FBVztnQkFDekMsWUFBWSxFQUFFLFVBQVUsQ0FBQyxJQUFJLENBQUMsV0FBVztnQkFDekMsWUFBWSxFQUFFLENBQUMsY0FBYyxFQUFFLFlBQVksRUFBRSxlQUFlLEVBQUUsV0FBVyxDQUFDO2FBQzNFO1NBQ0YsQ0FBQyxDQUFDO1FBRUgsZ0JBQWdCO1FBQ2hCLE1BQU0sY0FBYyxHQUFHLEdBQUcsQ0FBQyxJQUFJLENBQUMsV0FBVyxDQUFDLFFBQVEsQ0FBQyxDQUFDO1FBQ3RELGNBQWMsQ0FBQyxTQUFTLENBQUMsTUFBTSxFQUFFLElBQUksVUFBVSxDQUFDLGlCQUFpQixDQUFDLFlBQVksQ0FBQyxDQUFDLENBQUM7UUFFakYsTUFBTSxlQUFlLEdBQUcsR0FBRyxDQUFDLElBQUksQ0FBQyxXQUFXLENBQUMsU0FBUyxDQUFDLENBQUM7UUFDeEQsZUFBZSxDQUFDLFNBQVMsQ0FBQyxLQUFLLEVBQUUsSUFBSSxVQUFVLENBQUMsaUJBQWlCLENBQUMsYUFBYSxDQUFDLENBQUMsQ0FBQztRQUVsRixNQUFNLGtCQUFrQixHQUFHLGVBQWUsQ0FBQyxXQUFXLENBQUMsY0FBYyxDQUFDLENBQUM7UUFDdkUsa0JBQWtCLENBQUMsU0FBUyxDQUFDLEtBQUssRUFBRSxJQUFJLFVBQVUsQ0FBQyxpQkFBaUIsQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDO1FBRXJGLHVDQUF1QztRQUN2QyxNQUFNLFlBQVksR0FBRyxJQUFJLFVBQVUsQ0FBQyxZQUFZLENBQUMsSUFBSSxFQUFFLHVCQUF1QixNQUFNLEVBQUUsRUFBRTtZQUN0RixlQUFlLEVBQUU7Z0JBQ2YsTUFBTSxFQUFFLE9BQU8sQ0FBQyxjQUFjLENBQUMsdUJBQXVCLENBQUMsY0FBYyxDQUFDO2dCQUN0RSxvQkFBb0IsRUFBRSxVQUFVLENBQUMsb0JBQW9CLENBQUMsaUJBQWlCO2FBQ3hFO1lBQ0QsaUJBQWlCLEVBQUUsWUFBWTtTQUNoQyxDQUFDLENBQUM7UUFFSCxVQUFVO1FBQ1YsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxRQUFRLEVBQUU7WUFDaEMsS0FBSyxFQUFFLEdBQUcsQ0FBQyxHQUFHO1lBQ2QsV0FBVyxFQUFFLGlCQUFpQjtTQUMvQixDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLGFBQWEsRUFBRTtZQUNyQyxLQUFLLEVBQUUsV0FBVyxZQUFZLENBQUMsc0JBQXNCLEVBQUU7WUFDdkQsV0FBVyxFQUFFLGNBQWM7U0FDNUIsQ0FBQyxDQUFDO1FBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxpQkFBaUIsRUFBRTtZQUN6QyxLQUFLLEVBQUUsZUFBZSxDQUFDLFVBQVU7WUFDakMsV0FBVyxFQUFFLHFCQUFxQjtTQUNuQyxDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLGNBQWMsRUFBRTtZQUN0QyxLQUFLLEVBQUUsWUFBWSxDQUFDLFNBQVM7WUFDN0IsV0FBVyxFQUFFLHdCQUF3QjtTQUN0QyxDQUFDLENBQUM7SUFDTCxDQUFDO0NBQ0Y7QUF4akJELGtDQXdqQkMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5pbXBvcnQgKiBhcyBzMyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtczMnO1xuaW1wb3J0ICogYXMgbGFtYmRhIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sYW1iZGEnO1xuaW1wb3J0ICogYXMgZHluYW1vZGIgZnJvbSAnYXdzLWNkay1saWIvYXdzLWR5bmFtb2RiJztcbmltcG9ydCAqIGFzIGFwaWdhdGV3YXkgZnJvbSAnYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXknO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gJ2F3cy1jZGstbGliL2F3cy1pYW0nO1xuaW1wb3J0ICogYXMgczNuIGZyb20gJ2F3cy1jZGstbGliL2F3cy1zMy1ub3RpZmljYXRpb25zJztcbmltcG9ydCAqIGFzIGNsb3VkZnJvbnQgZnJvbSAnYXdzLWNkay1saWIvYXdzLWNsb3VkZnJvbnQnO1xuaW1wb3J0ICogYXMgb3JpZ2lucyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtY2xvdWRmcm9udC1vcmlnaW5zJztcblxuZXhwb3J0IGNsYXNzIENka0FwcFN0YWNrIGV4dGVuZHMgY2RrLlN0YWNrIHtcbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM/OiBjZGsuU3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgY29uc3Qgc3VmZml4ID0gJzE3NTk0NDYxNDE4MjQnO1xuXG4gICAgLy8gRHluYW1vREIgdGFibGUgZm9yIHN0b3JpbmcgcHJvY2Vzc2luZyByZXN1bHRzXG4gICAgY29uc3QgcmVzdWx0c1RhYmxlID0gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsIGBJZHBSZXN1bHRzVGFibGUke3N1ZmZpeH1gLCB7XG4gICAgICB0YWJsZU5hbWU6IGBpZHAtcmVzdWx0cy0ke3N1ZmZpeH1gLFxuICAgICAgcGFydGl0aW9uS2V5OiB7IG5hbWU6ICdkb2N1bWVudElkJywgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgIHNvcnRLZXk6IHsgbmFtZTogJ3VwbG9hZFRpbWVzdGFtcCcsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuTlVNQkVSIH0sXG4gICAgICBiaWxsaW5nTW9kZTogZHluYW1vZGIuQmlsbGluZ01vZGUuUFJPVklTSU9ORUQsXG4gICAgICByZWFkQ2FwYWNpdHk6IDUsXG4gICAgICB3cml0ZUNhcGFjaXR5OiA1LFxuICAgICAgZW5jcnlwdGlvbjogZHluYW1vZGIuVGFibGVFbmNyeXB0aW9uLkFXU19NQU5BR0VELFxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWVxuICAgIH0pO1xuXG4gICAgLy8gUzMgYnVja2V0IGZvciBkb2N1bWVudCBzdG9yYWdlXG4gICAgY29uc3QgZG9jdW1lbnRzQnVja2V0ID0gbmV3IHMzLkJ1Y2tldCh0aGlzLCBgRG9jdW1lbnRzQnVja2V0JHtzdWZmaXh9YCwge1xuICAgICAgYnVja2V0TmFtZTogYGlkcC1kb2N1bWVudHMtJHtzdWZmaXh9YCxcbiAgICAgIHZlcnNpb25lZDogdHJ1ZSxcbiAgICAgIGVuY3J5cHRpb246IHMzLkJ1Y2tldEVuY3J5cHRpb24uUzNfTUFOQUdFRCxcbiAgICAgIGJsb2NrUHVibGljQWNjZXNzOiBzMy5CbG9ja1B1YmxpY0FjY2Vzcy5CTE9DS19BTEwsXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgICAgYXV0b0RlbGV0ZU9iamVjdHM6IHRydWVcbiAgICB9KTtcblxuICAgIC8vIFMzIGJ1Y2tldCBmb3IgZnJvbnRlbmQgaG9zdGluZ1xuICAgIGNvbnN0IGZyb250ZW5kQnVja2V0ID0gbmV3IHMzLkJ1Y2tldCh0aGlzLCBgRnJvbnRlbmRCdWNrZXQke3N1ZmZpeH1gLCB7XG4gICAgICBidWNrZXROYW1lOiBgaWRwLWZyb250ZW5kLSR7c3VmZml4fWAsXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgICAgYXV0b0RlbGV0ZU9iamVjdHM6IHRydWVcbiAgICB9KTtcblxuICAgIC8vIElBTSByb2xlIGZvciBMYW1iZGEgZnVuY3Rpb25zXG4gICAgY29uc3QgbGFtYmRhUm9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCBgTGFtYmRhUm9sZSR7c3VmZml4fWAsIHtcbiAgICAgIHJvbGVOYW1lOiBgaWRwLWxhbWJkYS1yb2xlLSR7c3VmZml4fWAsXG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbCgnbGFtYmRhLmFtYXpvbmF3cy5jb20nKSxcbiAgICAgIG1hbmFnZWRQb2xpY2llczogW1xuICAgICAgICBpYW0uTWFuYWdlZFBvbGljeS5mcm9tQXdzTWFuYWdlZFBvbGljeU5hbWUoJ3NlcnZpY2Utcm9sZS9BV1NMYW1iZGFCYXNpY0V4ZWN1dGlvblJvbGUnKVxuICAgICAgXSxcbiAgICAgIGlubGluZVBvbGljaWVzOiB7XG4gICAgICAgIElkcFBvbGljeTogbmV3IGlhbS5Qb2xpY3lEb2N1bWVudCh7XG4gICAgICAgICAgc3RhdGVtZW50czogW1xuICAgICAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICAgICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICAgICAgICAnczM6R2V0T2JqZWN0JyxcbiAgICAgICAgICAgICAgICAnczM6UHV0T2JqZWN0JyxcbiAgICAgICAgICAgICAgICAnczM6RGVsZXRlT2JqZWN0J1xuICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICByZXNvdXJjZXM6IFtkb2N1bWVudHNCdWNrZXQuYnVja2V0QXJuICsgJy8qJ11cbiAgICAgICAgICAgIH0pLFxuICAgICAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICAgICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICAgICAgICAnZHluYW1vZGI6UHV0SXRlbScsXG4gICAgICAgICAgICAgICAgJ2R5bmFtb2RiOkdldEl0ZW0nLFxuICAgICAgICAgICAgICAgICdkeW5hbW9kYjpVcGRhdGVJdGVtJyxcbiAgICAgICAgICAgICAgICAnZHluYW1vZGI6UXVlcnknLFxuICAgICAgICAgICAgICAgICdkeW5hbW9kYjpTY2FuJ1xuICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICByZXNvdXJjZXM6IFtyZXN1bHRzVGFibGUudGFibGVBcm5dXG4gICAgICAgICAgICB9KSxcbiAgICAgICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgICAgICAgJ3RleHRyYWN0OkRldGVjdERvY3VtZW50VGV4dCcsXG4gICAgICAgICAgICAgICAgJ3RleHRyYWN0OkFuYWx5emVEb2N1bWVudCdcbiAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgcmVzb3VyY2VzOiBbJyonXVxuICAgICAgICAgICAgfSksXG4gICAgICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgICAgICAgICdiZWRyb2NrOkludm9rZU1vZGVsJ1xuICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICByZXNvdXJjZXM6IFtcbiAgICAgICAgICAgICAgICAnYXJuOmF3czpiZWRyb2NrOio6KjppbmZlcmVuY2UtcHJvZmlsZS9nbG9iYWwuYW50aHJvcGljLmNsYXVkZS1zb25uZXQtNC0yMDI1MDUxNC12MTowJyxcbiAgICAgICAgICAgICAgICAnYXJuOmF3czpiZWRyb2NrOio6OmZvdW5kYXRpb24tbW9kZWwvYW50aHJvcGljLmNsYXVkZS1zb25uZXQtNC0yMDI1MDUxNC12MTowJ1xuICAgICAgICAgICAgICBdXG4gICAgICAgICAgICB9KSxcbiAgICAgICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgICAgICAgJ2xhbWJkYTpJbnZva2VGdW5jdGlvbidcbiAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgcmVzb3VyY2VzOiBbJyonXVxuICAgICAgICAgICAgfSlcbiAgICAgICAgICBdXG4gICAgICAgIH0pXG4gICAgICB9XG4gICAgfSk7XG5cbiAgICAvLyBVcGxvYWQgTGFtYmRhIGZ1bmN0aW9uXG4gICAgY29uc3QgdXBsb2FkTGFtYmRhID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCBgVXBsb2FkTGFtYmRhJHtzdWZmaXh9YCwge1xuICAgICAgZnVuY3Rpb25OYW1lOiBgaWRwLXVwbG9hZC0ke3N1ZmZpeH1gLFxuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuUFlUSE9OXzNfMTEsXG4gICAgICBoYW5kbGVyOiAnaW5kZXguaGFuZGxlcicsXG4gICAgICByb2xlOiBsYW1iZGFSb2xlLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgRE9DVU1FTlRTX0JVQ0tFVDogZG9jdW1lbnRzQnVja2V0LmJ1Y2tldE5hbWUsXG4gICAgICAgIFJFU1VMVFNfVEFCTEU6IHJlc3VsdHNUYWJsZS50YWJsZU5hbWVcbiAgICAgIH0sXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tSW5saW5lKGBcbmltcG9ydCBqc29uXG5pbXBvcnQgYm90bzNcbmltcG9ydCB1dWlkXG5pbXBvcnQgYmFzZTY0XG5pbXBvcnQgb3NcbmZyb20gZGF0ZXRpbWUgaW1wb3J0IGRhdGV0aW1lXG5cbnMzID0gYm90bzMuY2xpZW50KCdzMycpXG5keW5hbW9kYiA9IGJvdG8zLnJlc291cmNlKCdkeW5hbW9kYicpXG5cbmRlZiBoYW5kbGVyKGV2ZW50LCBjb250ZXh0KTpcbiAgICB0cnk6XG4gICAgICAgIHRhYmxlID0gZHluYW1vZGIuVGFibGUob3MuZW52aXJvblsnUkVTVUxUU19UQUJMRSddKVxuICAgICAgICBidWNrZXQgPSBvcy5lbnZpcm9uWydET0NVTUVOVFNfQlVDS0VUJ11cbiAgICAgICAgXG4gICAgICAgICMgUGFyc2UgdGhlIHJlcXVlc3RcbiAgICAgICAgYm9keSA9IGpzb24ubG9hZHMoZXZlbnRbJ2JvZHknXSlcbiAgICAgICAgZmlsZV9jb250ZW50ID0gYmFzZTY0LmI2NGRlY29kZShib2R5WydmaWxlJ10pXG4gICAgICAgIGZpbGVfbmFtZSA9IGJvZHlbJ2ZpbGVOYW1lJ11cbiAgICAgICAgXG4gICAgICAgICMgR2VuZXJhdGUgdW5pcXVlIGRvY3VtZW50IElEXG4gICAgICAgIGRvY3VtZW50X2lkID0gc3RyKHV1aWQudXVpZDQoKSlcbiAgICAgICAgdGltZXN0YW1wID0gaW50KGRhdGV0aW1lLm5vdygpLnRpbWVzdGFtcCgpICogMTAwMClcbiAgICAgICAgczNfa2V5ID0gZlwie2RvY3VtZW50X2lkfS97ZmlsZV9uYW1lfVwiXG4gICAgICAgIFxuICAgICAgICAjIFVwbG9hZCB0byBTM1xuICAgICAgICBzMy5wdXRfb2JqZWN0KFxuICAgICAgICAgICAgQnVja2V0PWJ1Y2tldCxcbiAgICAgICAgICAgIEtleT1zM19rZXksXG4gICAgICAgICAgICBCb2R5PWZpbGVfY29udGVudCxcbiAgICAgICAgICAgIENvbnRlbnRUeXBlPWJvZHkuZ2V0KCdjb250ZW50VHlwZScsICdhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW0nKVxuICAgICAgICApXG4gICAgICAgIFxuICAgICAgICAjIENyZWF0ZSBEeW5hbW9EQiByZWNvcmRcbiAgICAgICAgdGFibGUucHV0X2l0ZW0oXG4gICAgICAgICAgICBJdGVtPXtcbiAgICAgICAgICAgICAgICAnZG9jdW1lbnRJZCc6IGRvY3VtZW50X2lkLFxuICAgICAgICAgICAgICAgICd1cGxvYWRUaW1lc3RhbXAnOiB0aW1lc3RhbXAsXG4gICAgICAgICAgICAgICAgJ2ZpbGVOYW1lJzogZmlsZV9uYW1lLFxuICAgICAgICAgICAgICAgICdzM0tleSc6IHMzX2tleSxcbiAgICAgICAgICAgICAgICAnc3RhdHVzJzogJ3VwbG9hZGVkJ1xuICAgICAgICAgICAgfVxuICAgICAgICApXG4gICAgICAgIFxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgJ3N0YXR1c0NvZGUnOiAyMDAsXG4gICAgICAgICAgICAnaGVhZGVycyc6IHtcbiAgICAgICAgICAgICAgICAnQWNjZXNzLUNvbnRyb2wtQWxsb3ctT3JpZ2luJzogJyonLFxuICAgICAgICAgICAgICAgICdBY2Nlc3MtQ29udHJvbC1BbGxvdy1IZWFkZXJzJzogJ0NvbnRlbnQtVHlwZScsXG4gICAgICAgICAgICAgICAgJ0FjY2Vzcy1Db250cm9sLUFsbG93LU1ldGhvZHMnOiAnUE9TVCwgT1BUSU9OUydcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAnYm9keSc6IGpzb24uZHVtcHMoe1xuICAgICAgICAgICAgICAgICdkb2N1bWVudElkJzogZG9jdW1lbnRfaWQsXG4gICAgICAgICAgICAgICAgJ3N0YXR1cyc6ICd1cGxvYWRlZCdcbiAgICAgICAgICAgIH0pXG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgZXhjZXB0IEV4Y2VwdGlvbiBhcyBlOlxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgJ3N0YXR1c0NvZGUnOiA1MDAsXG4gICAgICAgICAgICAnaGVhZGVycyc6IHtcbiAgICAgICAgICAgICAgICAnQWNjZXNzLUNvbnRyb2wtQWxsb3ctT3JpZ2luJzogJyonXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgJ2JvZHknOiBqc29uLmR1bXBzKHsnZXJyb3InOiBzdHIoZSl9KVxuICAgICAgICB9XG5gKVxuICAgIH0pO1xuXG4gICAgLy8gT0NSIExhbWJkYSBmdW5jdGlvblxuICAgIGNvbnN0IG9jckxhbWJkYSA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgYE9jckxhbWJkYSR7c3VmZml4fWAsIHtcbiAgICAgIGZ1bmN0aW9uTmFtZTogYGlkcC1vY3ItJHtzdWZmaXh9YCxcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLlBZVEhPTl8zXzExLFxuICAgICAgaGFuZGxlcjogJ2luZGV4LmhhbmRsZXInLFxuICAgICAgcm9sZTogbGFtYmRhUm9sZSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwMCksXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBET0NVTUVOVFNfQlVDS0VUOiBkb2N1bWVudHNCdWNrZXQuYnVja2V0TmFtZSxcbiAgICAgICAgUkVTVUxUU19UQUJMRTogcmVzdWx0c1RhYmxlLnRhYmxlTmFtZSxcbiAgICAgICAgQ0xBU1NJRklDQVRJT05fTEFNQkRBOiBgaWRwLWNsYXNzaWZpY2F0aW9uLSR7c3VmZml4fWBcbiAgICAgIH0sXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tSW5saW5lKGBcbmltcG9ydCBqc29uXG5pbXBvcnQgYm90bzNcbmltcG9ydCBvc1xuZnJvbSBkYXRldGltZSBpbXBvcnQgZGF0ZXRpbWVcbmZyb20gYm90bzMuZHluYW1vZGIuY29uZGl0aW9ucyBpbXBvcnQgS2V5XG5mcm9tIGRlY2ltYWwgaW1wb3J0IERlY2ltYWxcblxudGV4dHJhY3QgPSBib3RvMy5jbGllbnQoJ3RleHRyYWN0JylcbmR5bmFtb2RiID0gYm90bzMucmVzb3VyY2UoJ2R5bmFtb2RiJylcbmxhbWJkYV9jbGllbnQgPSBib3RvMy5jbGllbnQoJ2xhbWJkYScpXG5cbmRlZiBoYW5kbGVyKGV2ZW50LCBjb250ZXh0KTpcbiAgICB0cnk6XG4gICAgICAgICMgUGFyc2UgUzMgZXZlbnRcbiAgICAgICAgYnVja2V0ID0gZXZlbnRbJ1JlY29yZHMnXVswXVsnczMnXVsnYnVja2V0J11bJ25hbWUnXVxuICAgICAgICBrZXkgPSBldmVudFsnUmVjb3JkcyddWzBdWydzMyddWydvYmplY3QnXVsna2V5J11cbiAgICAgICAgXG4gICAgICAgICMgRXh0cmFjdCBkb2N1bWVudCBJRCBmcm9tIGtleVxuICAgICAgICBkb2N1bWVudF9pZCA9IGtleS5zcGxpdCgnLycpWzBdXG4gICAgICAgIFxuICAgICAgICAjIEdldCB0aGUgZG9jdW1lbnQgcmVjb3JkIHRvIGZpbmQgdGhlIHRpbWVzdGFtcFxuICAgICAgICB0YWJsZSA9IGR5bmFtb2RiLlRhYmxlKG9zLmVudmlyb25bJ1JFU1VMVFNfVEFCTEUnXSlcbiAgICAgICAgcmVzcG9uc2UgPSB0YWJsZS5xdWVyeShcbiAgICAgICAgICAgIEtleUNvbmRpdGlvbkV4cHJlc3Npb249S2V5KCdkb2N1bWVudElkJykuZXEoZG9jdW1lbnRfaWQpXG4gICAgICAgIClcbiAgICAgICAgXG4gICAgICAgIGlmIG5vdCByZXNwb25zZVsnSXRlbXMnXTpcbiAgICAgICAgICAgIHByaW50KGZcIk5vIHJlY29yZCBmb3VuZCBmb3IgZG9jdW1lbnQgSUQ6IHtkb2N1bWVudF9pZH1cIilcbiAgICAgICAgICAgIHJldHVybiB7J3N0YXR1c0NvZGUnOiA0MDR9XG4gICAgICAgIFxuICAgICAgICBpdGVtID0gcmVzcG9uc2VbJ0l0ZW1zJ11bMF1cbiAgICAgICAgdGltZXN0YW1wID0gaXRlbVsndXBsb2FkVGltZXN0YW1wJ11cbiAgICAgICAgXG4gICAgICAgICMgUGVyZm9ybSBPQ1IgdXNpbmcgVGV4dHJhY3RcbiAgICAgICAgcmVzcG9uc2UgPSB0ZXh0cmFjdC5kZXRlY3RfZG9jdW1lbnRfdGV4dChcbiAgICAgICAgICAgIERvY3VtZW50PXtcbiAgICAgICAgICAgICAgICAnUzNPYmplY3QnOiB7XG4gICAgICAgICAgICAgICAgICAgICdCdWNrZXQnOiBidWNrZXQsXG4gICAgICAgICAgICAgICAgICAgICdOYW1lJzoga2V5XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICApXG4gICAgICAgIFxuICAgICAgICAjIEV4dHJhY3QgdGV4dFxuICAgICAgICBleHRyYWN0ZWRfdGV4dCA9IFwiXCJcbiAgICAgICAgY29uZmlkZW5jZV9zY29yZXMgPSBbXVxuICAgICAgICBcbiAgICAgICAgZm9yIGJsb2NrIGluIHJlc3BvbnNlWydCbG9ja3MnXTpcbiAgICAgICAgICAgIGlmIGJsb2NrWydCbG9ja1R5cGUnXSA9PSAnTElORSc6XG4gICAgICAgICAgICAgICAgZXh0cmFjdGVkX3RleHQgKz0gYmxvY2tbJ1RleHQnXSArIFwiXFxcXG5cIlxuICAgICAgICAgICAgICAgIGNvbmZpZGVuY2Vfc2NvcmVzLmFwcGVuZChibG9ja1snQ29uZmlkZW5jZSddKVxuICAgICAgICBcbiAgICAgICAgYXZnX2NvbmZpZGVuY2UgPSBEZWNpbWFsKHN0cihzdW0oY29uZmlkZW5jZV9zY29yZXMpIC8gbGVuKGNvbmZpZGVuY2Vfc2NvcmVzKSkpIGlmIGNvbmZpZGVuY2Vfc2NvcmVzIGVsc2UgRGVjaW1hbCgnMCcpXG4gICAgICAgIFxuICAgICAgICAjIFVwZGF0ZSBEeW5hbW9EQlxuICAgICAgICB0YWJsZS51cGRhdGVfaXRlbShcbiAgICAgICAgICAgIEtleT17J2RvY3VtZW50SWQnOiBkb2N1bWVudF9pZCwgJ3VwbG9hZFRpbWVzdGFtcCc6IHRpbWVzdGFtcH0sXG4gICAgICAgICAgICBVcGRhdGVFeHByZXNzaW9uPSdTRVQgb2NyUmVzdWx0cyA9IDpvY3IsICNzdGF0dXMgPSA6c3RhdHVzJyxcbiAgICAgICAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lcz17JyNzdGF0dXMnOiAnc3RhdHVzJ30sXG4gICAgICAgICAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzPXtcbiAgICAgICAgICAgICAgICAnOm9jcic6IHtcbiAgICAgICAgICAgICAgICAgICAgJ2V4dHJhY3RlZFRleHQnOiBleHRyYWN0ZWRfdGV4dCxcbiAgICAgICAgICAgICAgICAgICAgJ2NvbmZpZGVuY2UnOiBhdmdfY29uZmlkZW5jZSxcbiAgICAgICAgICAgICAgICAgICAgJ3Byb2Nlc3NlZEF0JzogRGVjaW1hbChzdHIoaW50KGRhdGV0aW1lLm5vdygpLnRpbWVzdGFtcCgpICogMTAwMCkpKVxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgJzpzdGF0dXMnOiAnb2NyLWNvbXBsZXRlJ1xuICAgICAgICAgICAgfVxuICAgICAgICApXG4gICAgICAgIFxuICAgICAgICAjIFRyaWdnZXIgY2xhc3NpZmljYXRpb25cbiAgICAgICAgbGFtYmRhX2NsaWVudC5pbnZva2UoXG4gICAgICAgICAgICBGdW5jdGlvbk5hbWU9b3MuZW52aXJvblsnQ0xBU1NJRklDQVRJT05fTEFNQkRBJ10sXG4gICAgICAgICAgICBJbnZvY2F0aW9uVHlwZT0nRXZlbnQnLFxuICAgICAgICAgICAgUGF5bG9hZD1qc29uLmR1bXBzKHsnZG9jdW1lbnRJZCc6IGRvY3VtZW50X2lkLCAndGltZXN0YW1wJzogaW50KHRpbWVzdGFtcCksICd0ZXh0JzogZXh0cmFjdGVkX3RleHR9KVxuICAgICAgICApXG4gICAgICAgIFxuICAgICAgICByZXR1cm4geydzdGF0dXNDb2RlJzogMjAwfVxuICAgICAgICBcbiAgICBleGNlcHQgRXhjZXB0aW9uIGFzIGU6XG4gICAgICAgIHByaW50KGZcIkVycm9yOiB7c3RyKGUpfVwiKVxuICAgICAgICByZXR1cm4geydzdGF0dXNDb2RlJzogNTAwLCAnYm9keSc6IGpzb24uZHVtcHMoeydlcnJvcic6IHN0cihlKX0pfVxuYClcbiAgICB9KTtcblxuICAgIC8vIENsYXNzaWZpY2F0aW9uIExhbWJkYSBmdW5jdGlvblxuICAgIGNvbnN0IGNsYXNzaWZpY2F0aW9uTGFtYmRhID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCBgQ2xhc3NpZmljYXRpb25MYW1iZGEke3N1ZmZpeH1gLCB7XG4gICAgICBmdW5jdGlvbk5hbWU6IGBpZHAtY2xhc3NpZmljYXRpb24tJHtzdWZmaXh9YCxcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLlBZVEhPTl8zXzExLFxuICAgICAgaGFuZGxlcjogJ2luZGV4LmhhbmRsZXInLFxuICAgICAgcm9sZTogbGFtYmRhUm9sZSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwMCksXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBSRVNVTFRTX1RBQkxFOiByZXN1bHRzVGFibGUudGFibGVOYW1lLFxuICAgICAgICBTVU1NQVJJWkFUSU9OX0xBTUJEQTogYGlkcC1zdW1tYXJpemF0aW9uLSR7c3VmZml4fWBcbiAgICAgIH0sXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tSW5saW5lKGBcbmltcG9ydCBqc29uXG5pbXBvcnQgYm90bzNcbmltcG9ydCBvc1xuZnJvbSBkYXRldGltZSBpbXBvcnQgZGF0ZXRpbWVcbmZyb20gZGVjaW1hbCBpbXBvcnQgRGVjaW1hbFxuXG5iZWRyb2NrID0gYm90bzMuY2xpZW50KCdiZWRyb2NrLXJ1bnRpbWUnKVxuZHluYW1vZGIgPSBib3RvMy5yZXNvdXJjZSgnZHluYW1vZGInKVxubGFtYmRhX2NsaWVudCA9IGJvdG8zLmNsaWVudCgnbGFtYmRhJylcblxuZGVmIGhhbmRsZXIoZXZlbnQsIGNvbnRleHQpOlxuICAgIHRyeTpcbiAgICAgICAgZG9jdW1lbnRfaWQgPSBldmVudFsnZG9jdW1lbnRJZCddXG4gICAgICAgIHRpbWVzdGFtcCA9IGV2ZW50Wyd0aW1lc3RhbXAnXVxuICAgICAgICB0ZXh0ID0gZXZlbnRbJ3RleHQnXVxuICAgICAgICBcbiAgICAgICAgIyBDbGFzc2lmeSBkb2N1bWVudCB1c2luZyBCZWRyb2NrXG4gICAgICAgIHByb21wdCA9IGZcIlwiXCJDbGFzc2lmeSB0aGUgZm9sbG93aW5nIGRvY3VtZW50IHRleHQgaW50byBvbmUgb2YgdGhlc2UgY2F0ZWdvcmllczpcbiAgICAgICAgLSBJbnZvaWNlXG4gICAgICAgIC0gQ29udHJhY3RcbiAgICAgICAgLSBSZXBvcnRcbiAgICAgICAgLSBMZXR0ZXJcbiAgICAgICAgLSBGb3JtXG4gICAgICAgIC0gT3RoZXJcbiAgICAgICAgXG4gICAgICAgIERvY3VtZW50IHRleHQ6XG4gICAgICAgIHt0ZXh0WzoyMDAwXX1cbiAgICAgICAgXG4gICAgICAgIFJlc3BvbmQgd2l0aCBvbmx5IHRoZSBjYXRlZ29yeSBuYW1lLlwiXCJcIlxuICAgICAgICBcbiAgICAgICAgcmVzcG9uc2UgPSBiZWRyb2NrLmludm9rZV9tb2RlbChcbiAgICAgICAgICAgIG1vZGVsSWQ9J2dsb2JhbC5hbnRocm9waWMuY2xhdWRlLXNvbm5ldC00LTIwMjUwNTE0LXYxOjAnLFxuICAgICAgICAgICAgYm9keT1qc29uLmR1bXBzKHtcbiAgICAgICAgICAgICAgICAnYW50aHJvcGljX3ZlcnNpb24nOiAnYmVkcm9jay0yMDIzLTA1LTMxJyxcbiAgICAgICAgICAgICAgICAnbWF4X3Rva2Vucyc6IDEwMCxcbiAgICAgICAgICAgICAgICAnbWVzc2FnZXMnOiBbeydyb2xlJzogJ3VzZXInLCAnY29udGVudCc6IHByb21wdH1dXG4gICAgICAgICAgICB9KVxuICAgICAgICApXG4gICAgICAgIFxuICAgICAgICByZXN1bHQgPSBqc29uLmxvYWRzKHJlc3BvbnNlWydib2R5J10ucmVhZCgpKVxuICAgICAgICBjYXRlZ29yeSA9IHJlc3VsdFsnY29udGVudCddWzBdWyd0ZXh0J10uc3RyaXAoKVxuICAgICAgICBcbiAgICAgICAgIyBVcGRhdGUgRHluYW1vREJcbiAgICAgICAgdGFibGUgPSBkeW5hbW9kYi5UYWJsZShvcy5lbnZpcm9uWydSRVNVTFRTX1RBQkxFJ10pXG4gICAgICAgIHRhYmxlLnVwZGF0ZV9pdGVtKFxuICAgICAgICAgICAgS2V5PXsnZG9jdW1lbnRJZCc6IGRvY3VtZW50X2lkLCAndXBsb2FkVGltZXN0YW1wJzogRGVjaW1hbChzdHIodGltZXN0YW1wKSl9LFxuICAgICAgICAgICAgVXBkYXRlRXhwcmVzc2lvbj0nU0VUIGNsYXNzaWZpY2F0aW9uID0gOmNsYXNzaWZpY2F0aW9uLCAjc3RhdHVzID0gOnN0YXR1cycsXG4gICAgICAgICAgICBFeHByZXNzaW9uQXR0cmlidXRlTmFtZXM9eycjc3RhdHVzJzogJ3N0YXR1cyd9LFxuICAgICAgICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlcz17XG4gICAgICAgICAgICAgICAgJzpjbGFzc2lmaWNhdGlvbic6IHtcbiAgICAgICAgICAgICAgICAgICAgJ2NhdGVnb3J5JzogY2F0ZWdvcnksXG4gICAgICAgICAgICAgICAgICAgICdjb25maWRlbmNlJzogRGVjaW1hbCgnMC44NScpLFxuICAgICAgICAgICAgICAgICAgICAncHJvY2Vzc2VkQXQnOiBEZWNpbWFsKHN0cihpbnQoZGF0ZXRpbWUubm93KCkudGltZXN0YW1wKCkgKiAxMDAwKSkpXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAnOnN0YXR1cyc6ICdjbGFzc2lmaWVkJ1xuICAgICAgICAgICAgfVxuICAgICAgICApXG4gICAgICAgIFxuICAgICAgICAjIFRyaWdnZXIgc3VtbWFyaXphdGlvblxuICAgICAgICBsYW1iZGFfY2xpZW50Lmludm9rZShcbiAgICAgICAgICAgIEZ1bmN0aW9uTmFtZT1vcy5lbnZpcm9uWydTVU1NQVJJWkFUSU9OX0xBTUJEQSddLFxuICAgICAgICAgICAgSW52b2NhdGlvblR5cGU9J0V2ZW50JyxcbiAgICAgICAgICAgIFBheWxvYWQ9anNvbi5kdW1wcyh7J2RvY3VtZW50SWQnOiBkb2N1bWVudF9pZCwgJ3RpbWVzdGFtcCc6IHRpbWVzdGFtcCwgJ3RleHQnOiB0ZXh0fSlcbiAgICAgICAgKVxuICAgICAgICBcbiAgICAgICAgcmV0dXJuIHsnc3RhdHVzQ29kZSc6IDIwMH1cbiAgICAgICAgXG4gICAgZXhjZXB0IEV4Y2VwdGlvbiBhcyBlOlxuICAgICAgICBwcmludChmXCJFcnJvcjoge3N0cihlKX1cIilcbiAgICAgICAgcmV0dXJuIHsnc3RhdHVzQ29kZSc6IDUwMCwgJ2JvZHknOiBqc29uLmR1bXBzKHsnZXJyb3InOiBzdHIoZSl9KX1cbmApXG4gICAgfSk7XG5cbiAgICAvLyBTdW1tYXJpemF0aW9uIExhbWJkYSBmdW5jdGlvblxuICAgIGNvbnN0IHN1bW1hcml6YXRpb25MYW1iZGEgPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsIGBTdW1tYXJpemF0aW9uTGFtYmRhJHtzdWZmaXh9YCwge1xuICAgICAgZnVuY3Rpb25OYW1lOiBgaWRwLXN1bW1hcml6YXRpb24tJHtzdWZmaXh9YCxcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLlBZVEhPTl8zXzExLFxuICAgICAgaGFuZGxlcjogJ2luZGV4LmhhbmRsZXInLFxuICAgICAgcm9sZTogbGFtYmRhUm9sZSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwMCksXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBSRVNVTFRTX1RBQkxFOiByZXN1bHRzVGFibGUudGFibGVOYW1lXG4gICAgICB9LFxuICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUlubGluZShgXG5pbXBvcnQganNvblxuaW1wb3J0IGJvdG8zXG5pbXBvcnQgb3NcbmZyb20gZGF0ZXRpbWUgaW1wb3J0IGRhdGV0aW1lXG5mcm9tIGRlY2ltYWwgaW1wb3J0IERlY2ltYWxcblxuYmVkcm9jayA9IGJvdG8zLmNsaWVudCgnYmVkcm9jay1ydW50aW1lJylcbmR5bmFtb2RiID0gYm90bzMucmVzb3VyY2UoJ2R5bmFtb2RiJylcblxuZGVmIGhhbmRsZXIoZXZlbnQsIGNvbnRleHQpOlxuICAgIHRyeTpcbiAgICAgICAgZG9jdW1lbnRfaWQgPSBldmVudFsnZG9jdW1lbnRJZCddXG4gICAgICAgIHRpbWVzdGFtcCA9IGV2ZW50Wyd0aW1lc3RhbXAnXVxuICAgICAgICB0ZXh0ID0gZXZlbnRbJ3RleHQnXVxuICAgICAgICBcbiAgICAgICAgIyBTdW1tYXJpemUgZG9jdW1lbnQgdXNpbmcgQmVkcm9ja1xuICAgICAgICBwcm9tcHQgPSBmXCJcIlwiUHJvdmlkZSBhIGNvbmNpc2Ugc3VtbWFyeSBvZiB0aGUgZm9sbG93aW5nIGRvY3VtZW50IGluIDItMyBzZW50ZW5jZXM6XG4gICAgICAgIFxuICAgICAgICB7dGV4dFs6MzAwMF19XG4gICAgICAgIFxuICAgICAgICBTdW1tYXJ5OlwiXCJcIlxuICAgICAgICBcbiAgICAgICAgcmVzcG9uc2UgPSBiZWRyb2NrLmludm9rZV9tb2RlbChcbiAgICAgICAgICAgIG1vZGVsSWQ9J2dsb2JhbC5hbnRocm9waWMuY2xhdWRlLXNvbm5ldC00LTIwMjUwNTE0LXYxOjAnLFxuICAgICAgICAgICAgYm9keT1qc29uLmR1bXBzKHtcbiAgICAgICAgICAgICAgICAnYW50aHJvcGljX3ZlcnNpb24nOiAnYmVkcm9jay0yMDIzLTA1LTMxJyxcbiAgICAgICAgICAgICAgICAnbWF4X3Rva2Vucyc6IDIwMCxcbiAgICAgICAgICAgICAgICAnbWVzc2FnZXMnOiBbeydyb2xlJzogJ3VzZXInLCAnY29udGVudCc6IHByb21wdH1dXG4gICAgICAgICAgICB9KVxuICAgICAgICApXG4gICAgICAgIFxuICAgICAgICByZXN1bHQgPSBqc29uLmxvYWRzKHJlc3BvbnNlWydib2R5J10ucmVhZCgpKVxuICAgICAgICBzdW1tYXJ5ID0gcmVzdWx0Wydjb250ZW50J11bMF1bJ3RleHQnXS5zdHJpcCgpXG4gICAgICAgIFxuICAgICAgICAjIFVwZGF0ZSBEeW5hbW9EQlxuICAgICAgICB0YWJsZSA9IGR5bmFtb2RiLlRhYmxlKG9zLmVudmlyb25bJ1JFU1VMVFNfVEFCTEUnXSlcbiAgICAgICAgdGFibGUudXBkYXRlX2l0ZW0oXG4gICAgICAgICAgICBLZXk9eydkb2N1bWVudElkJzogZG9jdW1lbnRfaWQsICd1cGxvYWRUaW1lc3RhbXAnOiBEZWNpbWFsKHN0cih0aW1lc3RhbXApKX0sXG4gICAgICAgICAgICBVcGRhdGVFeHByZXNzaW9uPSdTRVQgc3VtbWFyeSA9IDpzdW1tYXJ5LCAjc3RhdHVzID0gOnN0YXR1cycsXG4gICAgICAgICAgICBFeHByZXNzaW9uQXR0cmlidXRlTmFtZXM9eycjc3RhdHVzJzogJ3N0YXR1cyd9LFxuICAgICAgICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlcz17XG4gICAgICAgICAgICAgICAgJzpzdW1tYXJ5Jzoge1xuICAgICAgICAgICAgICAgICAgICAndGV4dCc6IHN1bW1hcnksXG4gICAgICAgICAgICAgICAgICAgICdwcm9jZXNzZWRBdCc6IERlY2ltYWwoc3RyKGludChkYXRldGltZS5ub3coKS50aW1lc3RhbXAoKSAqIDEwMDApKSlcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICc6c3RhdHVzJzogJ3N1bW1hcml6ZWQnXG4gICAgICAgICAgICB9XG4gICAgICAgIClcbiAgICAgICAgXG4gICAgICAgIHJldHVybiB7J3N0YXR1c0NvZGUnOiAyMDB9XG4gICAgICAgIFxuICAgIGV4Y2VwdCBFeGNlcHRpb24gYXMgZTpcbiAgICAgICAgcHJpbnQoZlwiRXJyb3I6IHtzdHIoZSl9XCIpXG4gICAgICAgIHJldHVybiB7J3N0YXR1c0NvZGUnOiA1MDAsICdib2R5JzoganNvbi5kdW1wcyh7J2Vycm9yJzogc3RyKGUpfSl9XG5gKVxuICAgIH0pO1xuXG4gICAgLy8gUmVzdWx0cyBMYW1iZGEgZnVuY3Rpb25cbiAgICBjb25zdCByZXN1bHRzTGFtYmRhID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCBgUmVzdWx0c0xhbWJkYSR7c3VmZml4fWAsIHtcbiAgICAgIGZ1bmN0aW9uTmFtZTogYGlkcC1yZXN1bHRzLSR7c3VmZml4fWAsXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5QWVRIT05fM18xMSxcbiAgICAgIGhhbmRsZXI6ICdpbmRleC5oYW5kbGVyJyxcbiAgICAgIHJvbGU6IGxhbWJkYVJvbGUsXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBSRVNVTFRTX1RBQkxFOiByZXN1bHRzVGFibGUudGFibGVOYW1lXG4gICAgICB9LFxuICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUlubGluZShgXG5pbXBvcnQganNvblxuaW1wb3J0IGJvdG8zXG5pbXBvcnQgb3NcbmZyb20gYm90bzMuZHluYW1vZGIuY29uZGl0aW9ucyBpbXBvcnQgS2V5XG5mcm9tIGRlY2ltYWwgaW1wb3J0IERlY2ltYWxcblxuZHluYW1vZGIgPSBib3RvMy5yZXNvdXJjZSgnZHluYW1vZGInKVxuXG5jbGFzcyBEZWNpbWFsRW5jb2Rlcihqc29uLkpTT05FbmNvZGVyKTpcbiAgICBkZWYgZGVmYXVsdChzZWxmLCBvKTpcbiAgICAgICAgaWYgaXNpbnN0YW5jZShvLCBEZWNpbWFsKTpcbiAgICAgICAgICAgIHJldHVybiBmbG9hdChvKVxuICAgICAgICByZXR1cm4gc3VwZXIoRGVjaW1hbEVuY29kZXIsIHNlbGYpLmRlZmF1bHQobylcblxuZGVmIGhhbmRsZXIoZXZlbnQsIGNvbnRleHQpOlxuICAgIHRyeTpcbiAgICAgICAgdGFibGUgPSBkeW5hbW9kYi5UYWJsZShvcy5lbnZpcm9uWydSRVNVTFRTX1RBQkxFJ10pXG4gICAgICAgIFxuICAgICAgICAjIEhhbmRsZSBkaWZmZXJlbnQgSFRUUCBtZXRob2RzXG4gICAgICAgIGh0dHBfbWV0aG9kID0gZXZlbnRbJ2h0dHBNZXRob2QnXVxuICAgICAgICBcbiAgICAgICAgaWYgaHR0cF9tZXRob2QgPT0gJ0dFVCc6XG4gICAgICAgICAgICBwYXRoX3BhcmFtZXRlcnMgPSBldmVudC5nZXQoJ3BhdGhQYXJhbWV0ZXJzJywge30pXG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIHBhdGhfcGFyYW1ldGVycyBhbmQgJ2RvY3VtZW50SWQnIGluIHBhdGhfcGFyYW1ldGVyczpcbiAgICAgICAgICAgICAgICAjIEdldCBzcGVjaWZpYyBkb2N1bWVudFxuICAgICAgICAgICAgICAgIGRvY3VtZW50X2lkID0gcGF0aF9wYXJhbWV0ZXJzWydkb2N1bWVudElkJ11cbiAgICAgICAgICAgICAgICByZXNwb25zZSA9IHRhYmxlLnF1ZXJ5KFxuICAgICAgICAgICAgICAgICAgICBLZXlDb25kaXRpb25FeHByZXNzaW9uPUtleSgnZG9jdW1lbnRJZCcpLmVxKGRvY3VtZW50X2lkKVxuICAgICAgICAgICAgICAgIClcbiAgICAgICAgICAgICAgICBpdGVtcyA9IHJlc3BvbnNlWydJdGVtcyddXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICAgICAgJ3N0YXR1c0NvZGUnOiAyMDAsXG4gICAgICAgICAgICAgICAgICAgICdoZWFkZXJzJzoge1xuICAgICAgICAgICAgICAgICAgICAgICAgJ0FjY2Vzcy1Db250cm9sLUFsbG93LU9yaWdpbic6ICcqJyxcbiAgICAgICAgICAgICAgICAgICAgICAgICdBY2Nlc3MtQ29udHJvbC1BbGxvdy1IZWFkZXJzJzogJ0NvbnRlbnQtVHlwZScsXG4gICAgICAgICAgICAgICAgICAgICAgICAnQWNjZXNzLUNvbnRyb2wtQWxsb3ctTWV0aG9kcyc6ICdHRVQsIE9QVElPTlMnXG4gICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICdib2R5JzoganNvbi5kdW1wcyhpdGVtc1swXSBpZiBpdGVtcyBlbHNlIHt9LCBjbHM9RGVjaW1hbEVuY29kZXIpXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgZWxzZTpcbiAgICAgICAgICAgICAgICAjIEdldCBhbGwgZG9jdW1lbnRzXG4gICAgICAgICAgICAgICAgcmVzcG9uc2UgPSB0YWJsZS5zY2FuKClcbiAgICAgICAgICAgICAgICBpdGVtcyA9IHJlc3BvbnNlWydJdGVtcyddXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICAgICAgJ3N0YXR1c0NvZGUnOiAyMDAsXG4gICAgICAgICAgICAgICAgICAgICdoZWFkZXJzJzoge1xuICAgICAgICAgICAgICAgICAgICAgICAgJ0FjY2Vzcy1Db250cm9sLUFsbG93LU9yaWdpbic6ICcqJyxcbiAgICAgICAgICAgICAgICAgICAgICAgICdBY2Nlc3MtQ29udHJvbC1BbGxvdy1IZWFkZXJzJzogJ0NvbnRlbnQtVHlwZScsXG4gICAgICAgICAgICAgICAgICAgICAgICAnQWNjZXNzLUNvbnRyb2wtQWxsb3ctTWV0aG9kcyc6ICdHRVQsIE9QVElPTlMnXG4gICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICdib2R5JzoganNvbi5kdW1wcyhpdGVtcywgY2xzPURlY2ltYWxFbmNvZGVyKVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAnc3RhdHVzQ29kZSc6IDQwNSxcbiAgICAgICAgICAgICdoZWFkZXJzJzoge1xuICAgICAgICAgICAgICAgICdBY2Nlc3MtQ29udHJvbC1BbGxvdy1PcmlnaW4nOiAnKidcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAnYm9keSc6IGpzb24uZHVtcHMoeydlcnJvcic6ICdNZXRob2Qgbm90IGFsbG93ZWQnfSlcbiAgICAgICAgfVxuICAgICAgICBcbiAgICBleGNlcHQgRXhjZXB0aW9uIGFzIGU6XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAnc3RhdHVzQ29kZSc6IDUwMCxcbiAgICAgICAgICAgICdoZWFkZXJzJzoge1xuICAgICAgICAgICAgICAgICdBY2Nlc3MtQ29udHJvbC1BbGxvdy1PcmlnaW4nOiAnKidcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAnYm9keSc6IGpzb24uZHVtcHMoeydlcnJvcic6IHN0cihlKX0pXG4gICAgICAgIH1cbmApXG4gICAgfSk7XG5cbiAgICAvLyBTMyBldmVudCBub3RpZmljYXRpb24gdG8gdHJpZ2dlciBPQ1JcbiAgICBkb2N1bWVudHNCdWNrZXQuYWRkRXZlbnROb3RpZmljYXRpb24oXG4gICAgICBzMy5FdmVudFR5cGUuT0JKRUNUX0NSRUFURUQsXG4gICAgICBuZXcgczNuLkxhbWJkYURlc3RpbmF0aW9uKG9jckxhbWJkYSlcbiAgICApO1xuXG4gICAgLy8gQVBJIEdhdGV3YXlcbiAgICBjb25zdCBhcGkgPSBuZXcgYXBpZ2F0ZXdheS5SZXN0QXBpKHRoaXMsIGBJZHBBcGkke3N1ZmZpeH1gLCB7XG4gICAgICByZXN0QXBpTmFtZTogYGlkcC1hcGktJHtzdWZmaXh9YCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnSURQIEFwcGxpY2F0aW9uIEFQSScsXG4gICAgICBkZWZhdWx0Q29yc1ByZWZsaWdodE9wdGlvbnM6IHtcbiAgICAgICAgYWxsb3dPcmlnaW5zOiBhcGlnYXRld2F5LkNvcnMuQUxMX09SSUdJTlMsXG4gICAgICAgIGFsbG93TWV0aG9kczogYXBpZ2F0ZXdheS5Db3JzLkFMTF9NRVRIT0RTLFxuICAgICAgICBhbGxvd0hlYWRlcnM6IFsnQ29udGVudC1UeXBlJywgJ1gtQW16LURhdGUnLCAnQXV0aG9yaXphdGlvbicsICdYLUFwaS1LZXknXVxuICAgICAgfVxuICAgIH0pO1xuXG4gICAgLy8gQVBJIGVuZHBvaW50c1xuICAgIGNvbnN0IHVwbG9hZFJlc291cmNlID0gYXBpLnJvb3QuYWRkUmVzb3VyY2UoJ3VwbG9hZCcpO1xuICAgIHVwbG9hZFJlc291cmNlLmFkZE1ldGhvZCgnUE9TVCcsIG5ldyBhcGlnYXRld2F5LkxhbWJkYUludGVncmF0aW9uKHVwbG9hZExhbWJkYSkpO1xuXG4gICAgY29uc3QgcmVzdWx0c1Jlc291cmNlID0gYXBpLnJvb3QuYWRkUmVzb3VyY2UoJ3Jlc3VsdHMnKTtcbiAgICByZXN1bHRzUmVzb3VyY2UuYWRkTWV0aG9kKCdHRVQnLCBuZXcgYXBpZ2F0ZXdheS5MYW1iZGFJbnRlZ3JhdGlvbihyZXN1bHRzTGFtYmRhKSk7XG4gICAgXG4gICAgY29uc3QgcmVzdWx0QnlJZFJlc291cmNlID0gcmVzdWx0c1Jlc291cmNlLmFkZFJlc291cmNlKCd7ZG9jdW1lbnRJZH0nKTtcbiAgICByZXN1bHRCeUlkUmVzb3VyY2UuYWRkTWV0aG9kKCdHRVQnLCBuZXcgYXBpZ2F0ZXdheS5MYW1iZGFJbnRlZ3JhdGlvbihyZXN1bHRzTGFtYmRhKSk7XG5cbiAgICAvLyBDbG91ZEZyb250IGRpc3RyaWJ1dGlvbiBmb3IgZnJvbnRlbmRcbiAgICBjb25zdCBkaXN0cmlidXRpb24gPSBuZXcgY2xvdWRmcm9udC5EaXN0cmlidXRpb24odGhpcywgYEZyb250ZW5kRGlzdHJpYnV0aW9uJHtzdWZmaXh9YCwge1xuICAgICAgZGVmYXVsdEJlaGF2aW9yOiB7XG4gICAgICAgIG9yaWdpbjogb3JpZ2lucy5TM0J1Y2tldE9yaWdpbi53aXRoT3JpZ2luQWNjZXNzQ29udHJvbChmcm9udGVuZEJ1Y2tldCksXG4gICAgICAgIHZpZXdlclByb3RvY29sUG9saWN5OiBjbG91ZGZyb250LlZpZXdlclByb3RvY29sUG9saWN5LlJFRElSRUNUX1RPX0hUVFBTXG4gICAgICB9LFxuICAgICAgZGVmYXVsdFJvb3RPYmplY3Q6ICdpbmRleC5odG1sJ1xuICAgIH0pO1xuXG4gICAgLy8gT3V0cHV0c1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdBcGlVcmwnLCB7XG4gICAgICB2YWx1ZTogYXBpLnVybCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnQVBJIEdhdGV3YXkgVVJMJ1xuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0Zyb250ZW5kVXJsJywge1xuICAgICAgdmFsdWU6IGBodHRwczovLyR7ZGlzdHJpYnV0aW9uLmRpc3RyaWJ1dGlvbkRvbWFpbk5hbWV9YCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnRnJvbnRlbmQgVVJMJ1xuICAgIH0pO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0RvY3VtZW50c0J1Y2tldCcsIHtcbiAgICAgIHZhbHVlOiBkb2N1bWVudHNCdWNrZXQuYnVja2V0TmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnRG9jdW1lbnRzIFMzIEJ1Y2tldCdcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdSZXN1bHRzVGFibGUnLCB7XG4gICAgICB2YWx1ZTogcmVzdWx0c1RhYmxlLnRhYmxlTmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnUmVzdWx0cyBEeW5hbW9EQiBUYWJsZSdcbiAgICB9KTtcbiAgfVxufVxuIl19