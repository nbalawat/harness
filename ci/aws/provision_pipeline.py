#!/usr/bin/env python3
"""Wire up the end-to-end AWS CodePipeline: Source -> CI -> Approval -> Deploy.

Creates (idempotent): a versioned source bucket + artifact bucket, a CodePipeline
service role, two CODEPIPELINE-flavored CodeBuild projects (CI + deploy), and the
pipeline itself. Uploads the repo as the pipeline source (an S3 change triggers a
run). GitHub source can replace the S3 source once a CodeStar connection exists.

  python3 ci/aws/provision_pipeline.py [--app-name pipeline-app] [--region us-east-1]
"""
import argparse
import json
import os
import time
import zipfile

import boto3

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
EXCLUDE_DIRS = {".git", "node_modules"}
EXCLUDE_TOP = {
    "commercialbanking", "fsi-kyc-desk", "kyc-desk-v2", "kyc-desk-v3", "kyc-final",
    "kyc-review-desk", "kyc-v17", "live-copilot", "live-copilot-2", "underwriting-desk",
    "underwriting-desk-v12", "your-app", "fsi-inputs",
}


def zip_source(zip_path):
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for root, dirs, files in os.walk(REPO):
            rel = os.path.relpath(root, REPO)
            top = rel.split(os.sep)[0]
            dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS and d != "dist" and not d.startswith(".harness") and not (rel == "." and d in EXCLUDE_TOP)]
            if rel != "." and top in EXCLUDE_TOP:
                continue
            for f in files:
                if f.endswith((".log", ".tsbuildinfo")):
                    continue
                z.write(os.path.join(root, f), os.path.join(rel, f) if rel != "." else f)


def ensure_bucket(s3, name, region):
    try:
        s3.head_bucket(Bucket=name)
    except Exception:
        s3.create_bucket(Bucket=name)
    s3.put_bucket_versioning(Bucket=name, VersioningConfiguration={"Status": "Enabled"})


def ensure_role(iam, name, principal, policy_arn="arn:aws:iam::aws:policy/AdministratorAccess"):
    try:
        return iam.get_role(RoleName=name)["Role"]["Arn"]
    except iam.exceptions.NoSuchEntityException:
        arn = iam.create_role(RoleName=name, AssumeRolePolicyDocument=json.dumps({
            "Version": "2012-10-17",
            "Statement": [{"Effect": "Allow", "Principal": {"Service": principal}, "Action": "sts:AssumeRole"}],
        }))["Role"]["Arn"]
        iam.attach_role_policy(RoleName=name, PolicyArn=policy_arn)  # demo: scope for prod
        time.sleep(12)
        return arn


def cp_project(cb, name, buildspec, role, privileged, env):
    cfg = dict(
        name=name,
        source={"type": "CODEPIPELINE", "buildspec": buildspec},
        artifacts={"type": "CODEPIPELINE"},
        environment={"type": "LINUX_CONTAINER", "image": "aws/codebuild/standard:7.0",
                     "computeType": "BUILD_GENERAL1_LARGE", "privilegedMode": privileged, "environmentVariables": env},
        serviceRole=role, timeoutInMinutes=50,
    )
    try:
        cb.create_project(**cfg); print(f"  project {name}: created")
    except cb.exceptions.ResourceAlreadyExistsException:
        cb.update_project(**cfg); print(f"  project {name}: updated")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--app-name", default="pipeline-app")
    ap.add_argument("--region", default=os.environ.get("AWS_REGION", "us-east-1"))
    args = ap.parse_args()
    acct = boto3.client("sts").get_caller_identity()["Account"]
    region = args.region
    s3 = boto3.client("s3", region_name=region)
    iam = boto3.client("iam")
    cb = boto3.client("codebuild", region_name=region)
    cp = boto3.client("codepipeline", region_name=region)

    src_bucket = f"harness-pipeline-src-{acct}"
    art_bucket = f"harness-pipeline-art-{acct}"
    print("buckets…")
    ensure_bucket(s3, src_bucket, region)
    ensure_bucket(s3, art_bucket, region)

    print("zipping + uploading source…")
    zip_source("/tmp/harness-pipeline-src.zip")
    s3.upload_file("/tmp/harness-pipeline-src.zip", src_bucket, "source.zip")

    cb_role = ensure_role(iam, "codebuild-harness-role", "codebuild.amazonaws.com")
    cp_role = ensure_role(iam, "codepipeline-harness-role", "codepipeline.amazonaws.com")

    print("codebuild projects (CODEPIPELINE)…")
    cp_project(cb, "harness-ci-cp", "ci/aws/harness-ci.buildspec.yml", cb_role, False,
               [{"name": "AWS_DEFAULT_REGION", "value": region}])
    cp_project(cb, "harness-deploy-cp", "ci/aws/deploy-app.buildspec.yml", cb_role, True,
               [{"name": "AWS_DEFAULT_REGION", "value": region}, {"name": "APP_NAME", "value": args.app_name}, {"name": "TARGET", "value": "aws-apprunner"}])

    pipeline = {
        "name": "harness-pipeline",
        "roleArn": cp_role,
        "artifactStore": {"type": "S3", "location": art_bucket},
        "stages": [
            {"name": "Source", "actions": [{
                "name": "Source", "actionTypeId": {"category": "Source", "owner": "AWS", "provider": "S3", "version": "1"},
                "configuration": {"S3Bucket": src_bucket, "S3ObjectKey": "source.zip", "PollForSourceChanges": "true"},
                "outputArtifacts": [{"name": "SourceArtifact"}]}]},
            {"name": "CI_Test_and_Certify", "actions": [{
                "name": "harness-ci", "actionTypeId": {"category": "Build", "owner": "AWS", "provider": "CodeBuild", "version": "1"},
                "configuration": {"ProjectName": "harness-ci-cp"},
                "inputArtifacts": [{"name": "SourceArtifact"}], "outputArtifacts": [{"name": "BuildArtifact"}]}]},
            {"name": "Approval", "actions": [{
                "name": "ReviewBeforeDeploy", "actionTypeId": {"category": "Approval", "owner": "AWS", "provider": "Manual", "version": "1"},
                "configuration": {}}]},
            {"name": "Deploy_App", "actions": [{
                "name": "harness-deploy-app", "actionTypeId": {"category": "Build", "owner": "AWS", "provider": "CodeBuild", "version": "1"},
                "configuration": {"ProjectName": "harness-deploy-cp"},
                "inputArtifacts": [{"name": "SourceArtifact"}]}]},
        ],
    }
    print("codepipeline…")
    try:
        cp.create_pipeline(pipeline=pipeline); print("  pipeline harness-pipeline: created")
    except cp.exceptions.PipelineNameInUseException:
        existing = cp.get_pipeline(name="harness-pipeline")["pipeline"]
        pipeline["metadata"] = {}
        cp.update_pipeline(pipeline=pipeline); print("  pipeline harness-pipeline: updated")

    print("\nWired: Source(S3) -> CI(test+certify) -> Manual Approval -> Deploy(App Runner)")
    print(f"Console: https://{region}.console.aws.amazon.com/codesuite/codepipeline/pipelines/harness-pipeline/view")
    print("Trigger a run by re-uploading source or:  aws codepipeline start-pipeline-execution --name harness-pipeline")


if __name__ == "__main__":
    main()
