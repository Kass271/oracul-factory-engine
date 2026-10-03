package com.oracul.app.system;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class SystemControllerTest {

    @Test
    void pingAnswersPong() {
        var response = new SystemController().ping();

        assertThat(response.getStatusCode().value()).isEqualTo(200);
        assertThat(response.getBody()).isNotNull();
        assertThat(response.getBody().getMessage()).isEqualTo("pong");
    }
}
