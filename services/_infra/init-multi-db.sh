#!/bin/bash
# Runs once when the postgres container's data volume is first initialized
# (mounted into /docker-entrypoint-initdb.d/). Each microservice gets its own
# database in the same Postgres instance - separate enough to enforce "no
# cross-service joins" at the connection level, without the operational cost
# of 11 separate Postgres servers at this stage of the product.
set -e

DATABASES="identity_db device_db messaging_db conversation_db notification_db contact_db template_db campaign_db billing_db warmer_db audit_db"

for db in $DATABASES; do
  echo "Creating database: $db"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
    CREATE DATABASE $db;
EOSQL
done
