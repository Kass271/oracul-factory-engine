package com.oracul.app.todos;

import com.oracul.app.api.TodosApi;
import com.oracul.app.api.model.NewTodo;
import com.oracul.app.api.model.Todo;
import java.util.List;
import org.springframework.data.domain.Sort;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class TodosController implements TodosApi {

    private final TodoRepository repository;

    public TodosController(TodoRepository repository) {
        this.repository = repository;
    }

    @Override
    public ResponseEntity<List<Todo>> listTodos() {
        return ResponseEntity.ok(repository.findAll(Sort.by("id")).stream().map(TodosController::toApi).toList());
    }

    @Override
    public ResponseEntity<Todo> createTodo(NewTodo newTodo) {
        TodoEntity saved = repository.save(new TodoEntity(newTodo.getTitle().trim()));
        return ResponseEntity.status(HttpStatus.CREATED).body(toApi(saved));
    }

    static Todo toApi(TodoEntity entity) {
        return new Todo().id(entity.getId()).title(entity.getTitle()).done(entity.isDone());
    }
}
