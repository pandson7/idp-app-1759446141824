import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';

export class CdkAppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
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
    documentsBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(ocrLambda)
    );

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
