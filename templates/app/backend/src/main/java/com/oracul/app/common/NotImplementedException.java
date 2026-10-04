package com.oracul.app.common;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.ResponseStatus;

/**
 * Contract sync marker (Oracul): an operation or branch the contract already has but no slice has implemented yet.
 * It answers 501, so a test of the missing behaviour fails on its assertion, not on the compile. The release check
 * requires that none is left.
 */
@ResponseStatus(HttpStatus.NOT_IMPLEMENTED)
public class NotImplementedException extends RuntimeException {
    public NotImplementedException() {
        super("not implemented yet (contract sync)");
    }
}
