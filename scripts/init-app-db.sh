#!/bin/bash
# Creates the pevo_app database for application state (tokens, anon mappings).
# Runs as part of postgres init (docker-entrypoint-initdb.d).
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE DATABASE pevo_app OWNER $POSTGRES_USER;
EOSQL
