#!/usr/bin/env bash
# Tears down everything infra/deploy.sh created: the CloudFormation stack, the four SecureString
# parameters deploy.sh wrote outside the stack, and the ECR repository with its images.
# `aws cloudformation delete-stack` alone leaves the keys in Parameter Store and the images in ECR.
#
# Needs: aws CLI v2, AWS credentials and AWS_REGION in the environment. Optional: STACK
# (interpreter-demo), read the same way as in deploy.sh. Every step is idempotent: a resource that
# is already gone is reported and skipped, so the script can be re-run after a partial failure.
# Parameter values are never read or printed. After a public demo, rotate the vendor keys too.
set -euo pipefail

STACK=${STACK:-interpreter-demo}
REGION=${AWS_REGION:?set AWS_REGION}
REPO=interpreter-demo

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
echo "Tearing down stack $STACK in account $ACCOUNT, region $REGION."

# 1. The stack: ECS service and cluster, the instance, the CloudFront distribution, roles, log group
#    and shutdown schedule. The distribution takes several minutes to disable and delete.
if out=$(aws cloudformation delete-stack --stack-name "$STACK" --region "$REGION" 2>&1); then
  echo "Stack $STACK: deleting, waiting for completion..."
  aws cloudformation wait stack-delete-complete --stack-name "$STACK" --region "$REGION"
  echo "Stack $STACK: deleted."
else
  case $out in
    *"does not exist"*) echo "Stack $STACK: already gone." ;;
    *) echo "$out" >&2; exit 1 ;;
  esac
fi

# 2. The keys: one call; names that no longer exist come back as InvalidParameters, not an error.
NAMES=()
for v in OPENAI_API_KEY ELEVENLABS_API_KEY CLAUDE_TRANSLATOR_API_KEY DEMO_ACCESS_TOKEN; do
  NAMES+=("/$STACK/$v")
done
deleted=$(aws ssm delete-parameters --names "${NAMES[@]}" --region "$REGION" \
  --query 'DeletedParameters' --output text)
echo "Parameters deleted: ${deleted:-none (already gone)}"

# 3. The image repository, images included (--force).
if out=$(aws ecr delete-repository --repository-name "$REPO" --force --region "$REGION" 2>&1 >/dev/null); then
  echo "ECR repository $REPO: deleted."
else
  case $out in
    *RepositoryNotFoundException*) echo "ECR repository $REPO: already gone." ;;
    *) echo "$out" >&2; exit 1 ;;
  esac
fi
echo "Done. Nothing from infra/deploy.sh remains in $REGION."
