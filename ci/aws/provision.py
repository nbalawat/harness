#!/usr/bin/env python3
"""Provision the harness CI/CD on AWS CodeBuild (idempotent).

Creates two CodeBuild projects:
  - harness-ci          runs ci/aws/harness-ci.buildspec.yml (test + certify gate)
  - harness-deploy-app  runs ci/aws/deploy-app.buildspec.yml (build + deploy an app)

Source: by default the repo is zipped to S3 (self-contained, runs now). Pass
--github <owner/repo> to source from GitHub instead (requires a CodeBuild GitHub
source credential in the account, and enables webhook triggers).

  python3 ci/aws/provision.py [--github nbalawat/harness] [--region us-east-1]

Then run:
  aws codebuild start-build --project-name harness-ci
  aws codebuild start-build --project-name harness-deploy-app \
      --environment-variables-override name=APP_NAME,value=my-app-v1 \
                                        name=DOMAIN,value=my-app-v1.otaras.com
"""
import argparse
import json
import os
import subprocess
import sys
import time
import zipfile

import boto3

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
EXCLUDE_DIRS = {".git", "node_modules"}
# run-workspace dirs (have run.json) + scratch — never ship them as CI source
EXCLUDE_TOP = {
    "commercialbanking", "fsi-kyc-desk", "kyc-desk-v2", "kyc-desk-v3", "kyc-final",
    "kyc-review-desk", "kyc-v17", "live-copilot", "live-copilot-2", "underwriting-desk",
    "underwriting-desk-v12", "your-app", "fsi-inputs",
}


def zip_source(zip_path):
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for root, dirs, files in os.walk(REPO):
            rel_root = os.path.relpath(root, REPO)
            top = rel_root.split(os.sep)[0]
            dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS and not (rel_root == "." and d in EXCLUDE_TOP) and d != "dist" and not d.startswith(".harness")]
            if rel_root != "." and top in EXCLUDE_TOP:
                continue
            for f in files:
                if f.endswith((".log", ".tsbuildinfo")):
                    continue
                z.write(os.path.join(root, f), os.path.join(rel_root, f) if rel_root != "." else f)


def ensure_role(iam):
    name = "codebuild-harness-role"
    try:
        return iam.get_role(RoleName=name)["Role"]["Arn"]
    except iam.exceptions.NoSuchEntityException:
        arn = iam.create_role(RoleName=name, AssumeRolePolicyDocument=json.dumps({
            "Version": "2012-10-17",
            "Statement": [{"Effect": "Allow", "Principal": {"Service": "codebuild.amazonaws.com"}, "Action": "sts:AssumeRole"}],
        }))["Role"]["Arn"]
        # Demo build role. Prod: scope to ECR + App Runner + PassRole + logs + S3.
        iam.attach_role_policy(RoleName=name, PolicyArn="arn:aws:iam::aws:policy/AdministratorAccess")
        time.sleep(12)
        return arn


def upsert_project(cb, name, buildspec, role, source, privileged, env_vars):
    cfg = dict(
        name=name,
        source={**source, "buildspec": buildspec},
        artifacts={"type": "NO_ARTIFACTS"},
        environment={
            "type": "LINUX_CONTAINER", "image": "aws/codebuild/standard:7.0",
            "computeType": "BUILD_GENERAL1_LARGE", "privilegedMode": privileged,
            "environmentVariables": env_vars,
        },
        serviceRole=role,
        timeoutInMinutes=50,
    )
    try:
        cb.create_project(**cfg)
        print(f"created project {name}")
    except cb.exceptions.ResourceAlreadyExistsException:
        cb.update_project(**cfg)
        print(f"updated project {name}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--github", help="owner/repo to source from GitHub (else S3 zip)")
    ap.add_argument("--region", default=os.environ.get("AWS_REGION", "us-east-1"))
    args = ap.parse_args()

    acct = boto3.client("sts").get_caller_identity()["Account"]
    iam = boto3.client("iam")
    cb = boto3.client("codebuild", region_name=args.region)
    role = ensure_role(iam)

    if args.github:
        source = {"type": "GITHUB", "location": f"https://github.com/{args.github}.git"}
        print(f"source: GitHub {args.github} (ensure a CodeBuild GitHub credential exists; add a webhook to auto-trigger)")
    else:
        s3 = boto3.client("s3", region_name=args.region)
        bucket = f"harness-cloudbuild-{acct}"
        try:
            s3.create_bucket(Bucket=bucket)
        except Exception:
            pass
        zpath = "/tmp/harness-ci-src.zip"
        print("zipping repo source…")
        zip_source(zpath)
        s3.upload_file(zpath, bucket, "harness-ci-src.zip")
        source = {"type": "S3", "location": f"{bucket}/harness-ci-src.zip"}
        print(f"source: s3://{bucket}/harness-ci-src.zip  (re-run this script to refresh)")

    env_deploy = [
        {"name": "AWS_DEFAULT_REGION", "value": args.region},
        {"name": "APP_NAME", "value": "harness-app-v1"},
        {"name": "TARGET", "value": "aws-apprunner"},
    ]
    upsert_project(cb, "harness-ci", "ci/aws/harness-ci.buildspec.yml", role, source, False,
                   [{"name": "AWS_DEFAULT_REGION", "value": args.region}])
    upsert_project(cb, "harness-deploy-app", "ci/aws/deploy-app.buildspec.yml", role, source, True, env_deploy)

    print("\nProvisioned. Run:")
    print("  aws codebuild start-build --project-name harness-ci")
    print("  aws codebuild start-build --project-name harness-deploy-app \\")
    print("      --environment-variables-override name=APP_NAME,value=my-app-v1 name=DOMAIN,value=my-app-v1.otaras.com")


if __name__ == "__main__":
    main()
