-- Baseline migration created by the factory skeleton. Feature tables come in V2+.
CREATE TABLE app_meta (
    meta_key   VARCHAR(100) PRIMARY KEY,
    meta_value VARCHAR(500) NOT NULL
);
