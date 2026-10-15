#!/usr/bin/env bash
# Builds the demo image with the .NET SDK (no Docker daemon), pushes it to ECR and deploys
# infra/demo.yml (T5, docs/GUARDRAILS.md G14). Run from the repo root after `npm run build` in web/.
#
# Needs: aws CLI v2 and the .NET 10 SDK; AWS credentials and AWS_REGION in the environment; and,
# for the app's secret, OPENAI_API_KEY, ELEVENLABS_API_KEY, CLAUDE_TRANSLATOR_API_KEY and
# DEMO_ACCESS_TOKEN. Their values go straight into Secrets Manager and are never printed.
# Optional: STACK (interpreter-demo), SHUTDOWN_AT (UTC, default 14 days from now), IMAGE_TAG.
set -euo pipefail

STACK=${STACK:-interpreter-demo}
REGION=${AWS_REGION:?set AWS_REGION}
TAG=${IMAGE_TAG:-$(git rev-parse --short HEAD)}
SHUTDOWN_AT=${SHUTDOWN_AT:-$(date -u -d '+14 days' +%Y-%m-%dT%H:%M:%S)}
[ -f web/dist/index.html ] || { echo "web/dist missing: run npm run build in web/ first" >&2; exit 1; }
for v in OPENAI_API_KEY ELEVENLABS_API_KEY CLAUDE_TRANSLATOR_API_KEY DEMO_ACCESS_TOKEN; do
  [ -n "${!v:-}" ] || { echo "$v is not set" >&2; exit 1; }
done

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGISTRY="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"

# 1. The secret: one JSON value, written from the environment, never echoed or put in the template.
SECRET_NAME="$STACK/app-keys"
SECRET_JSON=$(python3 -c 'import json,os;print(json.dumps({k:os.environ[k] for k in ["OPENAI_API_KEY","ELEVENLABS_API_KEY","CLAUDE_TRANSLATOR_API_KEY","DEMO_ACCESS_TOKEN"]}))')
if SECRET_ARN=$(aws secretsmanager describe-secret --secret-id "$SECRET_NAME" --query ARN --output text 2>/dev/null); then
  aws secretsmanager put-secret-value --secret-id "$SECRET_ARN" --secret-string "$SECRET_JSON" >/dev/null
else
  SECRET_ARN=$(aws secretsmanager create-secret --name "$SECRET_NAME" --secret-string "$SECRET_JSON" --query ARN --output text)
fi
unset SECRET_JSON

# 2. The image: ECR repository with a short lifecycle, then an SDK container publish.
REPO=interpreter-demo
aws ecr describe-repositories --repository-names "$REPO" >/dev/null 2>&1 ||
  aws ecr create-repository --repository-name "$REPO" --image-scanning-configuration scanOnPush=true >/dev/null
aws ecr put-lifecycle-policy --repository-name "$REPO" --lifecycle-policy-text \
  '{"rules":[{"rulePriority":1,"selection":{"tagStatus":"any","countType":"imageCountMoreThan","countNumber":3},"action":{"type":"expire"}}]}' >/dev/null
DOCKER_CONFIG=$(mktemp -d)
export DOCKER_CONFIG
trap 'rm -rf "$DOCKER_CONFIG"' EXIT
AUTH=$(printf 'AWS:%s' "$(aws ecr get-login-password)" | base64 -w0)
printf '{"auths":{"%s":{"auth":"%s"}}}' "$REGISTRY" "$AUTH" >"$DOCKER_CONFIG/config.json"
unset AUTH
dotnet publish server/Interpreter.Api -c Release -p:DemoImage=true \
  -p:ContainerRegistry="$REGISTRY" -p:ContainerRepository="$REPO" -p:ContainerImageTag="$TAG" \
  /t:PublishContainer --nologo -v q

# 3. The stack. Default VPC, its public subnets, and the CloudFront origin-facing prefix list.
VPC=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)
SUBNETS=$(aws ec2 describe-subnets --filters Name=vpc-id,Values="$VPC" Name=default-for-az,Values=true \
  --query 'Subnets[].SubnetId' --output text | tr '\t' ',')
PREFIX=$(aws ec2 describe-managed-prefix-lists \
  --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing \
  --query 'PrefixLists[0].PrefixListId' --output text)
aws cloudformation deploy --stack-name "$STACK" --template-file infra/demo.yml \
  --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset \
  --parameter-overrides ImageUri="$REGISTRY/$REPO:$TAG" VpcId="$VPC" SubnetIds="$SUBNETS" \
  SecretArn="$SECRET_ARN" CloudFrontPrefixListId="$PREFIX" ShutdownAt="$SHUTDOWN_AT"
aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].Outputs' --output table
echo "Scales to zero at $SHUTDOWN_AT UTC. Tear down: aws cloudformation delete-stack --stack-name $STACK"
