package com.oracul.app.system;

import com.oracul.app.api.SystemApi;
import com.oracul.app.api.model.Ping;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class SystemController implements SystemApi {

    @Override
    public ResponseEntity<Ping> ping() {
        return ResponseEntity.ok(new Ping("pong"));
    }
}
