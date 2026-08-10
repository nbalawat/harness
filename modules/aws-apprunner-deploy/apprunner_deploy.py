#!/usr/bin/env python3
"""App Runner create/update via boto3 — used by deploy.sh when the installed
AWS CLI predates the `apprunner` command. Reuses an already-pushed ECR image.

Env: APP_NAME, AWS_REGION, IMAGE (full ECR URI), PORT, CPU, MEMORY, AGENT_MODE,
DOMAIN (optional vanity FQDN). Prints LIVE_URL / SERVICE_ARN on success.
Security: least-privilege ECR access role, no secrets printed.
"""
import json
import os
import sys
import time

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_REGION", "us-east-1")
APP_NAME = os.environ["APP_NAME"]
IMAGE = os.environ["IMAGE"]
PORT = os.environ.get("PORT", "8000")
CPU = os.environ.get("CPU", "256")
MEMORY = os.environ.get("MEMORY", "512")
AGENT_MODE = os.environ.get("AGENT_MODE", "stub")
DOMAIN = os.environ.get("DOMAIN", "").strip()

ar = boto3.client("apprunner", region_name=REGION)
iam = boto3.client("iam")


def ensure_access_role():
    name = "AppRunnerECRAccessRole"
    try:
        return iam.get_role(RoleName=name)["Role"]["Arn"]
    except ClientError:
        pass
    arn = iam.create_role(
        RoleName=name,
        AssumeRolePolicyDocument=json.dumps({
            "Version": "2012-10-17",
            "Statement": [{"Effect": "Allow", "Principal": {"Service": "build.apprunner.amazonaws.com"}, "Action": "sts:AssumeRole"}],
        }),
    )["Role"]["Arn"]
    iam.attach_role_policy(RoleName=name, PolicyArn="arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess")
    time.sleep(12)  # role propagation before App Runner assumes it
    return arn


def find_service():
    for s in ar.list_services().get("ServiceSummaryList", []):
        if s["ServiceName"] == APP_NAME:
            return s["ServiceArn"]
    return None


def main():
    role_arn = ensure_access_role()
    src = {
        "ImageRepository": {
            "ImageIdentifier": IMAGE,
            "ImageRepositoryType": "ECR",
            "ImageConfiguration": {"Port": PORT, "RuntimeEnvironmentVariables": {"HARNESS_AGENT_MODE": AGENT_MODE}},
        },
        "AutoDeploymentsEnabled": False,
        "AuthenticationConfiguration": {"AccessRoleArn": role_arn},
    }
    arn = find_service()
    if arn:
        ar.update_service(ServiceArn=arn, SourceConfiguration=src, InstanceConfiguration={"Cpu": CPU, "Memory": MEMORY})
    else:
        arn = ar.create_service(
            ServiceName=APP_NAME,
            SourceConfiguration=src,
            InstanceConfiguration={"Cpu": CPU, "Memory": MEMORY},
            HealthCheckConfiguration={"Protocol": "TCP", "Interval": 20, "Timeout": 15, "HealthyThreshold": 1, "UnhealthyThreshold": 10},
        )["Service"]["ServiceArn"]

    print(f"SERVICE_ARN={arn}", flush=True)
    for _ in range(80):
        st = ar.describe_service(ServiceArn=arn)["Service"]["Status"]
        print(f"    status: {st}", flush=True)
        if st == "RUNNING":
            break
        if st in ("CREATE_FAILED", "DELETE_FAILED"):
            print("deploy failed", file=sys.stderr)
            sys.exit(1)
        time.sleep(15)
    url = "https://" + ar.describe_service(ServiceArn=arn)["Service"]["ServiceUrl"]
    print(f"LIVE_URL={url}", flush=True)

    if DOMAIN:
        zone = DOMAIN.split(".", 1)[1]
        r53 = boto3.client("route53")
        zid = next((z["Id"] for z in r53.list_hosted_zones()["HostedZones"] if z["Name"] == zone + "."), None)
        if zid:
            try:
                res = ar.associate_custom_domain(ServiceArn=arn, DomainName=DOMAIN)
                recs = res.get("CustomDomain", {}).get("CertificateValidationRecords", [])
                # Auto-create the DNS validation CNAMEs + the app CNAME in Route53 so the
                # vanity URL comes up without manual steps (domain still fully optional).
                changes = [{"Action": "UPSERT", "ResourceRecordSet": {"Name": r["Name"], "Type": r["Type"], "TTL": 300, "ResourceRecords": [{"Value": r["Value"]}]}} for r in recs if r.get("Name")]
                changes.append({"Action": "UPSERT", "ResourceRecordSet": {"Name": DOMAIN, "Type": "CNAME", "TTL": 300, "ResourceRecords": [{"Value": url.replace("https://", "")}]}})
                r53.change_resource_record_sets(HostedZoneId=zid, ChangeBatch={"Changes": changes})
                print(f"VANITY_URL=https://{DOMAIN}  (DNS + cert validation records written to Route53; propagation ~a few min)", flush=True)
            except ClientError as e:
                print(f"    custom-domain association skipped: {str(e)[:160]}", flush=True)
        else:
            print(f"    no Route53 zone for {zone}; app live at LIVE_URL", flush=True)
    print(f"DONE {APP_NAME} -> {url}", flush=True)


if __name__ == "__main__":
    main()
